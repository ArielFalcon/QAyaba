import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import Database from "better-sqlite3";
import { getHistory, getHistoryDatabase } from "../index";
import { backupDatabase } from "../backup";
import { SpecRecordSchema } from "../../../contract/commands";
import type { RunOutcome } from "../../../types";
import { LEARNING_RULE_LEDGER_LIMIT } from "./learning.repository";

test("createRecord stores an enqueued record findable by id", () => {
  const r = getHistory().runs.createRecord({ target: "e2e",  app: "hist-a", sha: "abcdef1234", mode: "diff" });
  assert.equal(r.status, "enqueued");
  assert.equal(getHistory().runs.getRecord(r.id)?.app, "hist-a");
});

/* Two triggers for the same SHA in the same millisecond (webhook re-delivery,
   double-submit) must never collide on the PRIMARY KEY. With a ms-resolution
   timestamp alone, two createRecord calls produce byte-identical ids → UNIQUE
   constraint → the second throw escapes unhandled and drops the trigger.
 */
test("two rapid createRecord calls for the same sha produce different ids", () => {
  const sha = "abcdef1234567";
  const frozenNow = Date.now();
  const originalNow = Date.now;
  Date.now = () => frozenNow;
  try {
    const a = getHistory().runs.createRecord({ target: "e2e", app: "hist-colid", sha, mode: "diff" });
    const b = getHistory().runs.createRecord({ target: "e2e", app: "hist-colid", sha, mode: "diff" });
    assert.notEqual(a.id, b.id);
    assert.ok(getHistory().runs.getRecord(a.id));
    assert.ok(getHistory().runs.getRecord(b.id));
  } finally {
    Date.now = originalNow;
  }
});

test("listRecords returns newest-first and respects the limit", () => {
  const app = "hist-b";
  const a = getHistory().runs.createRecord({ target: "e2e",  app, sha: "1111111", mode: "diff" });
  const b = getHistory().runs.createRecord({ target: "e2e",  app, sha: "2222222", mode: "complete" });
  const list = getHistory().runs.listRecords(app, 10);
  assert.equal(list[0]!.id, b.id);
  assert.equal(list[1]!.id, a.id);
  assert.equal(getHistory().runs.listRecords(app, 1).length, 1);
});

test("addCase upserts by name so a retry does not duplicate or inflate counts", () => {
  const r = getHistory().runs.createRecord({ target: "e2e",  app: "hist-c", sha: "3333333", mode: "diff" });
  getHistory().runs.addCase(r.id, { name: "checkout", status: "fail" });
  getHistory().runs.addCase(r.id, { name: "login", status: "pass" });
  getHistory().runs.addCase(r.id, { name: "checkout", status: "pass" });
  const rec = getHistory().runs.getRecord(r.id)!;
  assert.equal(rec.cases.length, 2); /* not 3 — upserted, not appended */
  assert.equal(rec.passed, 2);
  assert.equal(rec.failed, 0);
});

test("currentRun returns a running/enqueued record and skips finished ones", () => {
  const r = getHistory().runs.createRecord({ target: "e2e",  app: "hist-d", sha: "4444444", mode: "diff" });
  getHistory().runs.updateRecord(r.id, { status: "running" });
  assert.ok(getHistory().runs.currentRun());
  getHistory().runs.updateRecord(r.id, { status: "done", verdict: "pass" });
  assert.equal(getHistory().runs.getRecord(r.id)?.status, "done");
});

test("a spec with no objective/flow round-trips as undefined (not null) — wire-contract safe", () => {
  /* The single-agent (manual/diff fallback) path can report a spec without an objective; the DB stores
     an absent optional TEXT column as NULL. The read MUST normalize NULL → undefined, or the run's API
     response fails SpecRecordSchema (objective is optional, NOT nullable) — observed as a Zod
     "expected string, received null" on specs[].objective.
   */
  const r = getHistory().runs.createRecord({ target: "e2e", app: "hist-nullobj", sha: "9999999", mode: "manual" });
  getHistory().runs.updateRecord(r.id, { status: "done", verdict: "pass", specs: [{ name: "flows/x.spec.ts" }] });
  const spec = getHistory().runs.getRecord(r.id)!.specs![0]!;
  assert.equal(spec.name, "flows/x.spec.ts");
  assert.equal(spec.objective, undefined, "absent objective must read back as undefined, not null");
  assert.equal(spec.flow, undefined, "absent flow must read back as undefined, not null");
  assert.doesNotThrow(() => SpecRecordSchema.parse(spec), "the spec must satisfy the wire contract");
});

test("currentRun prefers running over enqueued when both exist (queue FIFO)", () => {
  getHistory().runs.clearDatabase();
  const olderRunning = getHistory().runs.createRecord({ target: "e2e", app: "hist-e-fifo", sha: "5555555", mode: "diff" });
  /* A second, newer enqueued record — the test's own point is that currentRun() must still prefer
     the running one, so this row's own id is never asserted, only its presence in the DB. */
  getHistory().runs.createRecord({ target: "e2e", app: "hist-e-fifo", sha: "6666666", mode: "diff" });
  getHistory().runs.updateRecord(olderRunning.id, { status: "running" });
  const cur = getHistory().runs.currentRun();
  assert.ok(cur);
  assert.equal(cur!.id, olderRunning.id, "must return the actually-running job, not the newest enqueued");
});

test("interruptedRecords returns running and enqueued records", () => {
  getHistory().runs.clearDatabase();
  const running = getHistory().runs.createRecord({ target: "e2e", app: "hist-zombie", sha: "7777777", mode: "diff" });
  const enqueued = getHistory().runs.createRecord({ target: "e2e", app: "hist-zombie", sha: "8888888", mode: "diff" });
  const done = getHistory().runs.createRecord({ target: "e2e", app: "hist-zombie", sha: "9999999", mode: "diff" });
  getHistory().runs.updateRecord(running.id, { status: "running" });
  getHistory().runs.updateRecord(enqueued.id, { status: "enqueued" });
  getHistory().runs.updateRecord(done.id, { status: "done", verdict: "pass" });
  const zombies = getHistory().runs.interruptedRecords();
  assert.equal(zombies.length, 2);
  const ids = new Set(zombies.map((z) => z.id));
  assert.ok(ids.has(running.id));
  assert.ok(ids.has(enqueued.id));
  assert.ok(!ids.has(done.id));
});

test("appendActivity round-trips structured events (kind, status, text) newest-last", () => {
  const r = getHistory().runs.createRecord({ target: "e2e", app: "hist-act", sha: "act0001", mode: "complete" });
  getHistory().runs.appendActivity(r.id, { kind: "todo", text: "read existing suite", status: "in_progress" });
  getHistory().runs.appendActivity(r.id, { kind: "file", text: "checkout.spec.ts" });
  getHistory().runs.appendActivity(r.id, { kind: "command", text: "npx playwright test --list" });
  const a = getHistory().runs.getRecord(r.id)!.activity!;
  assert.equal(a.length, 3);
  assert.equal(a[0]!.kind, "todo");
  assert.equal(a[0]!.status, "in_progress");
  assert.equal(a[2]!.text, "npx playwright test --list"); /* chronological, newest last */
  assert.ok(a[2]!.ts);
});

test("appendActivity caps the feed at 200 rows, keeping the newest", () => {
  const r = getHistory().runs.createRecord({ target: "e2e", app: "hist-cap", sha: "cap0001", mode: "complete" });
  for (let i = 0; i < 250; i++) getHistory().runs.appendActivity(r.id, { kind: "file", text: `spec-${i}.ts` });
  const a = getHistory().runs.getRecord(r.id)!.activity!;
  assert.equal(a.length, 200);
  assert.equal(a[a.length - 1]!.text, "spec-249.ts");
  assert.equal(a[0]!.text, "spec-50.ts");
});

test("updateRecord stamps stepStartedAt whenever the step changes", () => {
  const r = getHistory().runs.createRecord({ target: "e2e", app: "hist-step", sha: "step001", mode: "diff" });
  assert.equal(getHistory().runs.getRecord(r.id)!.stepStartedAt, undefined);
  getHistory().runs.updateRecord(r.id, { step: "generate" });
  const ts1 = getHistory().runs.getRecord(r.id)!.stepStartedAt;
  assert.ok(ts1 && !Number.isNaN(Date.parse(ts1)));
  getHistory().runs.updateRecord(r.id, { step: "execute" });
  const ts2 = getHistory().runs.getRecord(r.id)!.stepStartedAt;
  assert.ok(ts2 && ts2 !== ts1 || Date.parse(ts2!) >= Date.parse(ts1!));
});

test("a step written with a detail and then without one clears the detail", () => {
  const r = getHistory().runs.createRecord({ target: "e2e", app: "hist-step-detail", sha: "det0001", mode: "diff" });
  getHistory().runs.updateRecord(r.id, { step: "retry", stepDetail: "fix-loop engaged" });
  assert.equal(getHistory().runs.getRecord(r.id)!.stepDetail, "fix-loop engaged");
  getHistory().runs.updateRecord(r.id, { step: "coverage", stepDetail: null });
  assert.equal(getHistory().runs.getRecord(r.id)!.stepDetail, undefined);
});

test("continuationDepth walks the parentRunId chain", () => {
  const grandparent = getHistory().runs.createRecord({ target: "e2e", app: "hist-f", sha: "aaa0001", mode: "diff" });
  const parent = getHistory().runs.createRecord({ target: "e2e", app: "hist-f", sha: "aaa0001", mode: "diff", parentRunId: grandparent.id });
  const child = getHistory().runs.createRecord({ target: "e2e", app: "hist-f", sha: "aaa0001", mode: "diff", parentRunId: parent.id });
  assert.equal(getHistory().runs.continuationDepth(grandparent), 0);
  assert.equal(getHistory().runs.continuationDepth(parent), 1);
  assert.equal(getHistory().runs.continuationDepth(child), 2);
});

test("childrenOf lists the runs that name a parent, newest first, and none for a leaf", () => {
  const parent = getHistory().runs.createRecord({ target: "e2e", app: "hist-children", sha: "aaa0001", mode: "diff" });
  const heal = getHistory().runs.createRecord({ target: "e2e", app: "hist-children", sha: "aaa0001", mode: "context", parentRunId: parent.id });
  const continuation = getHistory().runs.createRecord({ target: "e2e", app: "hist-children", sha: "aaa0001", mode: "diff", parentRunId: parent.id });

  const children = getHistory().runs.childrenOf(parent.id);
  assert.deepEqual(children.map((c) => c.id), [continuation.id, heal.id], "every run that names the parent is listed, newest first");

  assert.equal(getHistory().runs.childrenOf(heal.id).length, 0, "a leaf run has no children");
});

/* The governance read feeds RuleGovernanceService (the single ranking truth) and must hand it the
   whole retrievable ledger: a large active set must neither crowd candidates out nor be truncated
   itself before governance ranks anything. */
test("listLearningRulesForGovernance: returns every active and candidate row however large the ledger", () => {
  const app = "hist-governance-no-starve";
  const activeTotal = LEARNING_RULE_LEDGER_LIMIT + 3;
  for (let i = 0; i < activeTotal; i++) {
    getHistory().learning.upsertLearningRule({
      id: `active-${i}`, app, trigger: `t${i}`, action: `a${i}`,
      errorClass: "E-EXEC-FAIL", source: "run", initialStatus: "active",
    });
  }
  getHistory().learning.upsertLearningRule({ id: "candidate-fresh-1", app, trigger: "fresh1", action: "a", errorClass: "E-EXEC-FAIL", source: "run" });
  getHistory().learning.upsertLearningRule({ id: "candidate-fresh-2", app, trigger: "fresh2", action: "a", errorClass: "E-EXEC-FAIL", source: "run" });

  const rows = getHistory().learning.listLearningRulesForGovernance(app);

  const candidateIds = rows.filter((r) => r.status === "candidate").map((r) => r.id);
  assert.deepEqual(new Set(candidateIds), new Set(["candidate-fresh-1", "candidate-fresh-2"]));
  assert.equal(rows.filter((r) => r.status === "active").length, activeTotal);
});

test("createRecord persists triggerRepo and getRecord returns it", () => {
  const rec = getHistory().runs.createRecord({ app: "shop", sha: "a1b2c3d", target: "e2e", mode: "diff", triggerRepo: "org/orders-svc" });
  assert.equal(getHistory().runs.getRecord(rec.id)?.triggerRepo, "org/orders-svc");
});

test("triggerRepo is optional and absent by default", () => {
  const rec = getHistory().runs.createRecord({ app: "shop", sha: "a1b2c3d", target: "e2e", mode: "diff" });
  assert.equal(getHistory().runs.getRecord(rec.id)?.triggerRepo, undefined);
});

test("purgeApp removes the app's runs (cascading cases/specs) but not other apps'", () => {
  const doomed = `hist-del-${Date.now().toString(36)}`;
  const alive = `hist-keep-${Date.now().toString(36)}`;
  const mine = getHistory().runs.createRecord({ app: doomed, sha: "a1b2c3d", target: "e2e", mode: "diff" });
  getHistory().runs.addCase(mine.id, { name: "t1", status: "pass" });
  const other = getHistory().runs.createRecord({ app: alive, sha: "a1b2c3d", target: "e2e", mode: "diff" });
  const removed = getHistory().purgeApp(doomed);
  assert.ok(removed >= 1);
  assert.equal(getHistory().runs.getRecord(mine.id), undefined);
  assert.ok(getHistory().runs.getRecord(other.id));
});

test("purgeApp also clears the app's stored context map", () => {
  const app = `hist-ctxmap-del-${Date.now().toString(36)}`;
  getHistory().contexts.saveContextMap(app, "sha1", { builtAtSha: "sha1", routes: [], api: [], feBe: [] });
  assert.ok(getHistory().contexts.loadContextMap(app), "sanity: stored before delete");
  getHistory().purgeApp(app);
  assert.equal(getHistory().contexts.loadContextMap(app), undefined, "purge must clear the app's context_maps row too");
});

/* ── backupDatabase (WAL-safe online backup) ──────────────────────────────────
   The backup must use better-sqlite3's native backup API, not a raw file copy:
   a copy of a WAL database can miss the -wal tail and produce a torn snapshot.
 */

test("backupDatabase writes a consistent, openable snapshot containing committed rows", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "hist-backup-"));
  const prevRoot = process.env.QAYABA_ROOT;
  process.env.QAYABA_ROOT = tmpRoot;
  try {
    const rec = getHistory().runs.createRecord({ app: "hist-backup", sha: "abc1234", target: "e2e", mode: "diff" });
    const r = await backupDatabase(getHistoryDatabase());
    assert.equal(r.backedUp, true);
    assert.ok(r.path && existsSync(r.path), "backup file must exist");
    /* The snapshot must be a valid SQLite DB holding the committed record. */
    const snapshot = new Database(r.path!, { readonly: true });
    try {
      const row = snapshot.prepare("SELECT COUNT(*) AS n FROM runs WHERE id = ?").get(rec.id) as { n: number };
      assert.equal(row.n, 1);
    } finally {
      snapshot.close();
    }
  } finally {
    if (prevRoot === undefined) delete process.env.QAYABA_ROOT;
    else process.env.QAYABA_ROOT = prevRoot;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("backupDatabase keeps only the last 7 backups", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "hist-backup-prune-"));
  const prevRoot = process.env.QAYABA_ROOT;
  process.env.QAYABA_ROOT = tmpRoot;
  try {
    const backupDir = join(tmpRoot, "data", "backups");
    mkdirSync(backupDir, { recursive: true });
    for (let i = 0; i < 9; i++) {
      writeFileSync(join(backupDir, `qayaba-0000-0${i}.db`), "stale");
    }
    const r = await backupDatabase(getHistoryDatabase());
    assert.equal(r.backedUp, true);
    const remaining = readdirSync(backupDir).filter((f) => f.startsWith("qayaba-") && f.endsWith(".db"));
    assert.equal(remaining.length, 7);
    assert.ok(remaining.includes(basename(r.path!)));
    assert.ok(!remaining.includes("qayaba-0000-00.db"));
  } finally {
    if (prevRoot === undefined) delete process.env.QAYABA_ROOT;
    else process.env.QAYABA_ROOT = prevRoot;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("the phases a run reached are stored on its record and read back, null for a run that recorded none", () => {
  const withPhases = getHistory().runs.createRecord({ target: "e2e", app: "hist-phases-a", sha: "abcdef1234", mode: "diff" });
  const without = getHistory().runs.createRecord({ target: "e2e", app: "hist-phases-a", sha: "abcdef1235", mode: "diff" });
  getHistory().runs.recordRunPhases(withPhases.id, { furthestPhase: "execute", phaseTimings: { gate: 3, execute: 900 } });

  assert.deepEqual(getHistory().runs.getRunPhases(withPhases.id), { furthestPhase: "execute", phaseTimings: { gate: 3, execute: 900 } });
  assert.deepEqual(getHistory().runs.getRunPhases(without.id), { furthestPhase: null, phaseTimings: null });
});

function finishedRun(app: string, verdict: RunOutcome["verdict"], furthestPhase: string | null, errorClass: string | null, at?: string): string {
  const r = getHistory().runs.createRecord({ target: "e2e", app, sha: "abcdef1234", mode: "diff" });
  getHistory().runs.updateRecord(r.id, { status: "done", verdict });
  if (furthestPhase) getHistory().runs.recordRunPhases(r.id, { furthestPhase, phaseTimings: {} });
  if (errorClass !== null) {
    getHistory().learning.saveRunOutcome({
      runId: r.id, app, sha: "abcdef1234", mode: "diff", target: "e2e", verdict, errorClass: errorClass as RunOutcome["errorClass"],
      gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
      rulesRetrieved: [], at: at ?? new Date().toISOString(),
    });
  }
  return r.id;
}

test("the funnel counts finished runs by furthest phase, verdict and error class, earliest phase first", () => {
  const app = "hist-funnel-a";
  finishedRun(app, "pass", "learn", null);
  finishedRun(app, "pass", "learn", null);
  finishedRun(app, "infra-error", "setup", "E-INFRA");
  finishedRun(app, "infra-error", "setup", "E-INFRA");
  finishedRun(app, "infra-error", "generate", "E-STEP-BUDGET");

  assert.deepEqual(getHistory().runs.getRunFunnel({ app }), [
    { furthestPhase: "setup", verdict: "infra-error", errorClass: "E-INFRA", count: 2 },
    { furthestPhase: "generate", verdict: "infra-error", errorClass: "E-STEP-BUDGET", count: 1 },
    { furthestPhase: "learn", verdict: "pass", errorClass: null, count: 2 },
  ]);
});

test("the funnel groups a run that recorded no phase apart, and leaves out runs that have not finished and other apps", () => {
  const app = "hist-funnel-b";
  finishedRun(app, "infra-error", null, null);
  finishedRun("hist-funnel-other", "pass", "learn", null);
  getHistory().runs.createRecord({ target: "e2e", app, sha: "abcdef1299", mode: "diff" });

  assert.deepEqual(getHistory().runs.getRunFunnel({ app }), [{ furthestPhase: null, verdict: "infra-error", errorClass: null, count: 1 }]);
});

test("the funnel narrowed by a date leaves out the runs before it, whatever the date's spelling", () => {
  const app = "hist-funnel-c";
  const id = finishedRun(app, "pass", "learn", null);
  const raw = new Database(process.env.HISTORY_DB_PATH!);
  raw.prepare("UPDATE runs SET at = ? WHERE id = ?").run("2026-10-01T12:00:00.000Z", id);
  raw.close();

  assert.equal(getHistory().runs.getRunFunnel({ app, since: "2026-10-01T12:00:01.000Z" }).length, 0);
  assert.equal(getHistory().runs.getRunFunnel({ app, since: "2026-10-01T11:59:59.000Z" }).length, 1);
  assert.equal(getHistory().runs.getRunFunnel({ app, since: "2026-10-01 12:00:01" }).length, 0, "a date without the T compares as a date, not as text");
  assert.equal(getHistory().runs.getRunFunnel({ app, since: "2026-10-01 11:00" }).length, 1);
});

test("a corrupt phase_timings value on a stored run yields the fallback and one warning naming the table, column and run", () => {
  const run = getHistory().runs.createRecord({ target: "e2e", app: "hist-corrupt-phases", sha: "abcdef1234", mode: "diff" });
  getHistory().runs.recordRunPhases(run.id, { furthestPhase: "setup", phaseTimings: { setup: 1 } });
  const raw = new Database(process.env.HISTORY_DB_PATH!);
  try {
    raw.prepare("UPDATE runs SET phase_timings = ? WHERE id = ?").run("{not json", run.id);
  } finally {
    raw.close();
  }

  const original = console.warn;
  const logged: string[] = [];
  console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    assert.deepEqual(getHistory().runs.getRunPhases(run.id), { furthestPhase: "setup", phaseTimings: null });
  } finally {
    console.warn = original;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /runs\.phase_timings/);
  assert.ok(logged[0]!.includes(run.id));
});
