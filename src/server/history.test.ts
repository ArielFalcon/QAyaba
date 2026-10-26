import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import Database from "better-sqlite3";
import { saveAgentTurnEvent, createRecord, getRecord, listRecords, currentRun, updateRecord, addCase, continuationDepth, childrenOf, clearDatabase, appendActivity, deleteAppHistory, interruptedRecords, saveAgentTurn, getAgentTurns, getAgentTurnTraces, recordRunPhases, getRunPhases, getRunFunnel } from "./history";
import { LEARNING_RULE_LEDGER_LIMIT } from "./persistence/repositories/learning.repository";
import { getHistoryDatabase } from "./persistence/index";
import { backupDatabase } from "./persistence/backup";
import { SpecRecordSchema } from "../contract/commands";
import type { RunOutcome, StructuredReflection, } from "../types";
import type { AgentTurnRecord } from "./history";
import type { AgentTurnEvent } from "@contexts/generation/infrastructure/agent-transport-policy";
import { CURRICULUM_CORRUPT } from "@contexts/cross-run-learning/application/index";
import { initCurriculum } from "@contexts/cross-run-learning/application/index";
import type { RuleStatus } from "../qa/learning/learning-rule";
import { getHistory } from "./persistence/index";

test("createRecord stores an enqueued record findable by id", () => {
  const r = createRecord({ target: "e2e",  app: "hist-a", sha: "abcdef1234", mode: "diff" });
  assert.equal(r.status, "enqueued");
  assert.equal(getRecord(r.id)?.app, "hist-a");
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
    const a = createRecord({ target: "e2e", app: "hist-colid", sha, mode: "diff" });
    const b = createRecord({ target: "e2e", app: "hist-colid", sha, mode: "diff" });
    assert.notEqual(a.id, b.id);
    assert.ok(getRecord(a.id));
    assert.ok(getRecord(b.id));
  } finally {
    Date.now = originalNow;
  }
});

test("listRecords returns newest-first and respects the limit", () => {
  const app = "hist-b";
  const a = createRecord({ target: "e2e",  app, sha: "1111111", mode: "diff" });
  const b = createRecord({ target: "e2e",  app, sha: "2222222", mode: "complete" });
  const list = listRecords(app, 10);
  assert.equal(list[0]!.id, b.id);
  assert.equal(list[1]!.id, a.id);
  assert.equal(listRecords(app, 1).length, 1);
});

test("addCase upserts by name so a retry does not duplicate or inflate counts", () => {
  const r = createRecord({ target: "e2e",  app: "hist-c", sha: "3333333", mode: "diff" });
  addCase(r.id, { name: "checkout", status: "fail" });
  addCase(r.id, { name: "login", status: "pass" });
  addCase(r.id, { name: "checkout", status: "pass" });
  const rec = getRecord(r.id)!;
  assert.equal(rec.cases.length, 2); /* not 3 — upserted, not appended */
  assert.equal(rec.passed, 2);
  assert.equal(rec.failed, 0);
});

test("currentRun returns a running/enqueued record and skips finished ones", () => {
  const r = createRecord({ target: "e2e",  app: "hist-d", sha: "4444444", mode: "diff" });
  updateRecord(r.id, { status: "running" });
  assert.ok(currentRun());
  updateRecord(r.id, { status: "done", verdict: "pass" });
  assert.equal(getRecord(r.id)?.status, "done");
});

test("a spec with no objective/flow round-trips as undefined (not null) — wire-contract safe", () => {
  /* The single-agent (manual/diff fallback) path can report a spec without an objective; the DB stores
     an absent optional TEXT column as NULL. The read MUST normalize NULL → undefined, or the run's API
     response fails SpecRecordSchema (objective is optional, NOT nullable) — observed as a Zod
     "expected string, received null" on specs[].objective.
   */
  const r = createRecord({ target: "e2e", app: "hist-nullobj", sha: "9999999", mode: "manual" });
  updateRecord(r.id, { status: "done", verdict: "pass", specs: [{ name: "flows/x.spec.ts" }] });
  const spec = getRecord(r.id)!.specs![0]!;
  assert.equal(spec.name, "flows/x.spec.ts");
  assert.equal(spec.objective, undefined, "absent objective must read back as undefined, not null");
  assert.equal(spec.flow, undefined, "absent flow must read back as undefined, not null");
  assert.doesNotThrow(() => SpecRecordSchema.parse(spec), "the spec must satisfy the wire contract");
});

test("currentRun prefers running over enqueued when both exist (queue FIFO)", () => {
  clearDatabase();
  const olderRunning = createRecord({ target: "e2e", app: "hist-e-fifo", sha: "5555555", mode: "diff" });
  /* A second, newer enqueued record — the test's own point is that currentRun() must still prefer
     the running one, so this row's own id is never asserted, only its presence in the DB. */
  createRecord({ target: "e2e", app: "hist-e-fifo", sha: "6666666", mode: "diff" });
  updateRecord(olderRunning.id, { status: "running" });
  const cur = currentRun();
  assert.ok(cur);
  assert.equal(cur!.id, olderRunning.id, "must return the actually-running job, not the newest enqueued");
});

test("interruptedRecords returns running and enqueued records", () => {
  clearDatabase();
  const running = createRecord({ target: "e2e", app: "hist-zombie", sha: "7777777", mode: "diff" });
  const enqueued = createRecord({ target: "e2e", app: "hist-zombie", sha: "8888888", mode: "diff" });
  const done = createRecord({ target: "e2e", app: "hist-zombie", sha: "9999999", mode: "diff" });
  updateRecord(running.id, { status: "running" });
  updateRecord(enqueued.id, { status: "enqueued" });
  updateRecord(done.id, { status: "done", verdict: "pass" });
  const zombies = interruptedRecords();
  assert.equal(zombies.length, 2);
  const ids = new Set(zombies.map((z) => z.id));
  assert.ok(ids.has(running.id));
  assert.ok(ids.has(enqueued.id));
  assert.ok(!ids.has(done.id));
});

test("appendActivity round-trips structured events (kind, status, text) newest-last", () => {
  const r = createRecord({ target: "e2e", app: "hist-act", sha: "act0001", mode: "complete" });
  appendActivity(r.id, { kind: "todo", text: "read existing suite", status: "in_progress" });
  appendActivity(r.id, { kind: "file", text: "checkout.spec.ts" });
  appendActivity(r.id, { kind: "command", text: "npx playwright test --list" });
  const a = getRecord(r.id)!.activity!;
  assert.equal(a.length, 3);
  assert.equal(a[0]!.kind, "todo");
  assert.equal(a[0]!.status, "in_progress");
  assert.equal(a[2]!.text, "npx playwright test --list"); /* chronological, newest last */
  assert.ok(a[2]!.ts);
});

test("appendActivity caps the feed at 200 rows, keeping the newest", () => {
  const r = createRecord({ target: "e2e", app: "hist-cap", sha: "cap0001", mode: "complete" });
  for (let i = 0; i < 250; i++) appendActivity(r.id, { kind: "file", text: `spec-${i}.ts` });
  const a = getRecord(r.id)!.activity!;
  assert.equal(a.length, 200);
  assert.equal(a[a.length - 1]!.text, "spec-249.ts");
  assert.equal(a[0]!.text, "spec-50.ts");
});

test("updateRecord stamps stepStartedAt whenever the step changes", () => {
  const r = createRecord({ target: "e2e", app: "hist-step", sha: "step001", mode: "diff" });
  assert.equal(getRecord(r.id)!.stepStartedAt, undefined);
  updateRecord(r.id, { step: "generate" });
  const ts1 = getRecord(r.id)!.stepStartedAt;
  assert.ok(ts1 && !Number.isNaN(Date.parse(ts1)));
  updateRecord(r.id, { step: "execute" });
  const ts2 = getRecord(r.id)!.stepStartedAt;
  assert.ok(ts2 && ts2 !== ts1 || Date.parse(ts2!) >= Date.parse(ts1!));
});

test("a step written with a detail and then without one clears the detail", () => {
  const r = createRecord({ target: "e2e", app: "hist-step-detail", sha: "det0001", mode: "diff" });
  updateRecord(r.id, { step: "retry", stepDetail: "fix-loop engaged" });
  assert.equal(getRecord(r.id)!.stepDetail, "fix-loop engaged");
  updateRecord(r.id, { step: "coverage", stepDetail: null });
  assert.equal(getRecord(r.id)!.stepDetail, undefined);
});

test("continuationDepth walks the parentRunId chain", () => {
  const grandparent = createRecord({ target: "e2e", app: "hist-f", sha: "aaa0001", mode: "diff" });
  const parent = createRecord({ target: "e2e", app: "hist-f", sha: "aaa0001", mode: "diff", parentRunId: grandparent.id });
  const child = createRecord({ target: "e2e", app: "hist-f", sha: "aaa0001", mode: "diff", parentRunId: parent.id });
  assert.equal(continuationDepth(grandparent), 0);
  assert.equal(continuationDepth(parent), 1);
  assert.equal(continuationDepth(child), 2);
});

test("childrenOf lists the runs that name a parent, newest first, and none for a leaf", () => {
  const parent = createRecord({ target: "e2e", app: "hist-children", sha: "aaa0001", mode: "diff" });
  const heal = createRecord({ target: "e2e", app: "hist-children", sha: "aaa0001", mode: "context", parentRunId: parent.id });
  const continuation = createRecord({ target: "e2e", app: "hist-children", sha: "aaa0001", mode: "diff", parentRunId: parent.id });

  const children = childrenOf(parent.id);
  assert.deepEqual(children.map((c) => c.id), [continuation.id, heal.id], "every run that names the parent is listed, newest first");

  assert.equal(childrenOf(heal.id).length, 0, "a leaf run has no children");
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
  const rec = createRecord({ app: "shop", sha: "a1b2c3d", target: "e2e", mode: "diff", triggerRepo: "org/orders-svc" });
  assert.equal(getRecord(rec.id)?.triggerRepo, "org/orders-svc");
});

test("triggerRepo is optional and absent by default", () => {
  const rec = createRecord({ app: "shop", sha: "a1b2c3d", target: "e2e", mode: "diff" });
  assert.equal(getRecord(rec.id)?.triggerRepo, undefined);
});

test("deleteAppHistory removes the app's runs (cascading cases/specs) but not other apps'", () => {
  const doomed = `hist-del-${Date.now().toString(36)}`;
  const alive = `hist-keep-${Date.now().toString(36)}`;
  const mine = createRecord({ app: doomed, sha: "a1b2c3d", target: "e2e", mode: "diff" });
  addCase(mine.id, { name: "t1", status: "pass" });
  const other = createRecord({ app: alive, sha: "a1b2c3d", target: "e2e", mode: "diff" });
  const removed = deleteAppHistory(doomed);
  assert.ok(removed >= 1);
  assert.equal(getRecord(mine.id), undefined);
  assert.ok(getRecord(other.id));
});

test("deleteAppHistory also clears the app's stored context map", () => {
  const app = `hist-ctxmap-del-${Date.now().toString(36)}`;
  getHistory().contexts.saveContextMap(app, "sha1", { builtAtSha: "sha1", routes: [], api: [], feBe: [] });
  assert.ok(getHistory().contexts.loadContextMap(app), "sanity: stored before delete");
  deleteAppHistory(app);
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
    const rec = createRecord({ app: "hist-backup", sha: "abc1234", target: "e2e", mode: "diff" });
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

function makeTurn(overrides: Partial<AgentTurnRecord> = {}): AgentTurnRecord {
  return {
    runId: "run-test-001",
    sessionId: "sess-abc",
    role: "qa-author",
    round: 0,
    isRepair: false,
    ts: new Date().toISOString(),
    objective: "test the login flow",
    promptText: "Write a Playwright test for the login feature.",
    outputText: "The test is written.",
    promptBytes: 43,
    tokensInput: 100,
    tokensOutput: 50,
    tokensReasoning: 10,
    tokensCacheRead: 5,
    tokensCacheWrite: 2,
    cost: 0.001,
    ...overrides,
  };
}

test("saveAgentTurn round-trips to getAgentTurns with all fields", () => {
  const turn = makeTurn();
  saveAgentTurn(turn);
  const rows = getAgentTurns(turn.runId!);
  assert.ok(rows.length >= 1, "at least one row must be returned");
  const saved = rows.find((r) => r.sessionId === turn.sessionId && r.role === turn.role);
  assert.ok(saved, "the saved turn must be retrievable by runId");
  assert.equal(saved!.role, "qa-author");
  assert.equal(saved!.round, 0);
  assert.equal(saved!.isRepair, false);
  assert.equal(saved!.promptText, turn.promptText);
  assert.equal(saved!.outputText, turn.outputText);
  assert.equal(saved!.promptBytes, turn.promptBytes);
  assert.equal(saved!.tokensInput, 100);
  assert.equal(saved!.tokensOutput, 50);
  assert.equal(saved!.tokensReasoning, 10);
  assert.equal(saved!.tokensCacheRead, 5);
  assert.equal(saved!.tokensCacheWrite, 2);
  assert.ok(Math.abs((saved!.cost ?? 0) - 0.001) < 1e-9);
  assert.equal(saved!.objective, "test the login flow");
});

function makeTurnEvent(overrides: Partial<AgentTurnEvent> = {}): AgentTurnEvent {
  return {
    runId: "run-event-001",
    sessionId: "sess-event",
    role: "qa-author",
    objective: undefined,
    round: 0,
    isRepair: false,
    promptText: "Write a test.",
    promptBytes: 13,
    outputText: "Done.",
    tokensInput: 10,
    tokensOutput: 5,
    tokensReasoning: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    cost: null,
    ts: new Date().toISOString(),
    sectionSizes: null,
    stepBudget: null,
    callMetrics: null,
    durationMs: null,
    ...overrides,
  };
}

test("saveAgentTurnEvent persists the step budget and the call metrics of a turn", () => {
  const runId = "run-event-metrics-" + Date.now();
  saveAgentTurnEvent(
    makeTurnEvent({
      runId,
      stepBudget: { maxSteps: 50, exhausted: true },
      callMetrics: {
        totalCalls: 31,
        stepsUsed: 50,
        observationComplete: true,
        callsBeforeFirstWrite: 27,
        writeCount: 2,
        commandCount: 1,
        redundantReadCount: 6, sameFileReadCount: 6,
        duplicateCallCount: 4,
        promptProvidedReadCount: 3,
        pathProvidedReadCount: 2, graphProvidedReadCount: 5,
        buckets: { code_read: 20, code_graph: 3, browser: 6, write: 2, validate_run: 1, script_run: 0, memory: 0, subagent: 0, other: 2 },
        timeToFirstCallMs: 1_800,
        timeToFirstWriteMs: 95_000,
        deniedCallCount: 2,
        toolSequence: [
          { tool: "read", target: "src/app/a.ts" },
          { tool: "grep", target: "createUser", scope: "src" },
          { tool: "bash", target: "rm -rf /", denied: true },
        ],
        usage: { input: 52_000, output: 1_900, reasoning: 400, cacheRead: 1_200_000, cacheWrite: 0, cost: 0.0421, steps: 50 },
      },
      durationMs: 361_500,
    }),
  );
  const [saved] = getAgentTurns(runId);
  assert.equal(saved!.maxSteps, 50);
  assert.equal(saved!.exhausted, true);
  assert.equal(saved!.totalCalls, 31);
  assert.equal(saved!.stepsUsed, 50);
  assert.equal(saved!.callsBeforeFirstWrite, 27);
  assert.equal(saved!.writeCount, 2);
  assert.equal(saved!.redundantReadCount, 6);
  assert.equal(saved!.duplicateCallCount, 4);
  assert.equal(saved!.promptProvidedReadCount, 3);
  assert.equal(saved!.pathProvidedReadCount, 2, "the path-provided count is stored apart from the content-provided one");
  assert.equal(saved!.graphProvidedReadCount, 5, "the graph-provided count is stored apart from the prompt's two");
  assert.deepEqual(saved!.callBuckets, { code_read: 20, code_graph: 3, browser: 6, write: 2, validate_run: 1, script_run: 0, memory: 0, subagent: 0, other: 2 });
  assert.equal(saved!.durationMs, 361_500);
  assert.equal(saved!.timeToFirstCallMs, 1_800);
  assert.equal(saved!.timeToFirstWriteMs, 95_000);
  assert.equal(saved!.deniedCallCount, 2);
  assert.deepEqual(saved!.usageTotal, { input: 52_000, output: 1_900, reasoning: 400, cacheRead: 1_200_000, cacheWrite: 0, cost: 0.0421, steps: 50 }, "the usage of every step is kept apart from the last message's tokens");
  assert.deepEqual(saved!.toolSequence, [
    { tool: "read", target: "src/app/a.ts" },
    { tool: "grep", target: "createUser", scope: "src" },
    { tool: "bash", target: "rm -rf /", denied: true },
  ]);
});

test("saveAgentTurnEvent keeps the model asked for and the one that answered, the attempt, the error class, the prompt's hashes and the limits", () => {
  const runId = "run-event-trace-" + Date.now();
  saveAgentTurnEvent(makeTurnEvent({
    runId,
    sessionId: "s-traced",
    sectionSizes: { task: 120, "working-rules": 4_000 },
    modelRequested: "prov/asked",
    modelAnswered: "answered-model",
    provider: "prov",
    attempt: 2,
    fallbackUsed: true,
    errorType: "socket_closed",
    sectionHashes: { task: "a".repeat(64), "working-rules": "b".repeat(64) },
    promptHash: "c".repeat(64),
    limitApplied: "tier-budget",
    limitFired: "step-cap",
  }));
  saveAgentTurnEvent(makeTurnEvent({ runId, sessionId: "s-untraced" }));
  const turns = getAgentTurnTraces(runId);
  assert.equal(getAgentTurns(runId).length, 2, "the public turn view still lists both rows");
  const traced = turns.find((t) => t.sessionId === "s-traced")!;
  assert.deepEqual(
    [traced.modelRequested, traced.modelAnswered, traced.provider, traced.attempt, traced.fallbackUsed, traced.errorType, traced.limitApplied, traced.limitFired],
    ["prov/asked", "answered-model", "prov", 2, true, "socket_closed", "tier-budget", "step-cap"],
  );
  assert.deepEqual(traced.sectionSizes, { task: 120, "working-rules": 4_000 });
  assert.deepEqual(traced.sectionHashes, { task: "a".repeat(64), "working-rules": "b".repeat(64) });
  assert.equal(traced.promptHash, "c".repeat(64));
  const untraced = turns.find((t) => t.sessionId === "s-untraced")!;
  assert.deepEqual(
    [untraced.modelRequested, untraced.modelAnswered, untraced.provider, untraced.attempt, untraced.fallbackUsed, untraced.errorType, untraced.sectionSizes, untraced.sectionHashes, untraced.promptHash, untraced.limitApplied, untraced.limitFired],
    [null, null, null, null, null, null, null, null, null, null, null],
    "a turn that carries none of it reads back as unknown, never as an empty value",
  );
});

test("a turn that wrote nothing keeps its unknown time to first write and an empty tool sequence apart from a turn that was not measured", () => {
  const runId = "run-event-sequence-" + Date.now();
  saveAgentTurnEvent(makeTurnEvent({
    runId,
    sessionId: "s-measured",
    callMetrics: {
      totalCalls: 0, stepsUsed: 1, observationComplete: true, callsBeforeFirstWrite: 0, writeCount: 0, commandCount: 0, redundantReadCount: 0, sameFileReadCount: 0,
      duplicateCallCount: 0, promptProvidedReadCount: 0, pathProvidedReadCount: 0, graphProvidedReadCount: 0,
      buckets: { code_read: 0, code_graph: 0, browser: 0, write: 0, validate_run: 0, script_run: 0, memory: 0, subagent: 0, other: 0 },
      timeToFirstCallMs: null, timeToFirstWriteMs: null, deniedCallCount: 0, toolSequence: [], usage: null,
    },
  }));
  saveAgentTurnEvent(makeTurnEvent({ runId, sessionId: "s-unmeasured", callMetrics: null }));
  const turns = getAgentTurns(runId);
  const measured = turns.find((t) => t.sessionId === "s-measured")!;
  assert.equal(measured.deniedCallCount, 0);
  assert.deepEqual(measured.toolSequence, []);
  assert.equal(measured.usageTotal, null, "a measured turn with no finished step has no usage, not a zero one");
  assert.equal(measured.timeToFirstWriteMs, null);
  const unmeasured = turns.find((t) => t.sessionId === "s-unmeasured")!;
  assert.equal(unmeasured.deniedCallCount, null, "no measurement is not zero denials");
  assert.equal(unmeasured.toolSequence, null);
  assert.equal(unmeasured.usageTotal, null);
  assert.equal(unmeasured.durationMs, null);
});

test("saveAgentTurnEvent keeps how a turn ended, and a turn that never answered reads back with its partial calls and empty output", () => {
  const runId = "run-event-ended-" + Date.now();
  saveAgentTurnEvent(makeTurnEvent({ runId, round: 0, ended: "completed" }));
  saveAgentTurnEvent(makeTurnEvent({
    runId,
    round: 1,
    outputText: "",
    ended: "timeout",
    stepBudget: { maxSteps: 50, exhausted: false },
    callMetrics: {
      totalCalls: 31, stepsUsed: 12, observationComplete: true, callsBeforeFirstWrite: 31, writeCount: 0, commandCount: 0, redundantReadCount: 0, sameFileReadCount: 0,
      duplicateCallCount: 0, promptProvidedReadCount: 0, pathProvidedReadCount: 0, graphProvidedReadCount: 0,
      buckets: { code_read: 20, code_graph: 0, browser: 6, write: 0, validate_run: 1, script_run: 4, memory: 0, subagent: 0, other: 0 },
      timeToFirstCallMs: 70_000, timeToFirstWriteMs: null, deniedCallCount: 0, toolSequence: [], usage: null,
    },
  }));
  const [answered, timedOut] = getAgentTurns(runId);
  assert.equal(answered!.ended, "completed");
  assert.equal(timedOut!.ended, "timeout");
  assert.equal(timedOut!.outputText, "");
  assert.equal(timedOut!.totalCalls, 31);
  assert.equal(timedOut!.callBuckets?.script_run, 4);
});

test("saveAgentTurnEvent leaves the end null, never a guess, when the transport does not say how the turn ended", () => {
  const runId = "run-event-ended-null-" + Date.now();
  saveAgentTurnEvent(makeTurnEvent({ runId }));
  assert.equal(getAgentTurns(runId)[0]!.ended, null);
});

test("saveAgentTurnEvent stores nulls, never zero or false, when a runtime reports no step budget or call metrics", () => {
  const runId = "run-event-null-" + Date.now();
  saveAgentTurnEvent(makeTurnEvent({ runId, stepBudget: null, callMetrics: null }));
  const [saved] = getAgentTurns(runId);
  assert.equal(saved!.maxSteps, null);
  assert.equal(saved!.exhausted, null);
  assert.equal(saved!.totalCalls, null);
  assert.equal(saved!.stepsUsed, null);
  assert.equal(saved!.callBuckets, null);
});

test("saveAgentTurnEvent keeps an unknown step limit (null) apart from a known exhaustion flag and an unknown steps-used", () => {
  const runId = "run-event-partial-" + Date.now();
  saveAgentTurnEvent(makeTurnEvent({ runId, stepBudget: { maxSteps: null, exhausted: false } }));
  const [saved] = getAgentTurns(runId);
  assert.equal(saved!.maxSteps, null);
  assert.equal(saved!.exhausted, false);
  assert.equal(saved!.stepsUsed, null);
});

test("saveAgentTurnEvent keeps a turn whose exhaustion is unknown apart from one known not exhausted, and reads it back as unknown", () => {
  const runId = "run-event-unknown-exhaustion-" + Date.now();
  saveAgentTurnEvent(makeTurnEvent({ runId, sessionId: "s-unknown", stepBudget: { maxSteps: 50, exhausted: null } }));
  saveAgentTurnEvent(makeTurnEvent({ runId, sessionId: "s-known", stepBudget: { maxSteps: 50, exhausted: false } }));
  const turns = getAgentTurns(runId);
  assert.equal(turns.find((t) => t.sessionId === "s-unknown")!.exhausted, null);
  assert.equal(turns.find((t) => t.sessionId === "s-known")!.exhausted, false);
  assert.equal(turns.find((t) => t.sessionId === "s-unknown")!.maxSteps, 50);
});

test("saveAgentTurn stores null-runId turns (sessions with no parent run)", () => {
  const turn = makeTurn({ runId: null, sessionId: "sess-no-run" });
  /* Should not throw — null runId is explicitly valid (e.g. maintainer, chat sessions). */
  assert.doesNotThrow(() => saveAgentTurn(turn));
});

test("getAgentTurns returns multiple turns in chronological order", () => {
  const runId = "run-order-test-" + Date.now();
  saveAgentTurn(makeTurn({ runId, sessionId: "s1", round: 0, role: "qa-author", promptText: "first" }));
  saveAgentTurn(makeTurn({ runId, sessionId: "s1", round: 1, role: "qa-author", promptText: "second" }));
  saveAgentTurn(makeTurn({ runId, sessionId: "s2", round: 0, role: "qa-reviewer", promptText: "review" }));
  const rows = getAgentTurns(runId);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.promptText, "first");
  assert.equal(rows[1]!.promptText, "second");
  assert.equal(rows[2]!.role, "qa-reviewer");
});

test("saveAgentTurn accepts null token fields (a runtime that reports no tokens)", () => {
  const runId = "run-null-tokens-" + Date.now();
  const turn = makeTurn({
    runId,
    sessionId: "sess-null-tokens",
    tokensInput: null,
    tokensOutput: null,
    tokensReasoning: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    cost: null,
  });
  saveAgentTurn(turn);
  const rows = getAgentTurns(runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.tokensInput, null);
  assert.equal(rows[0]!.tokensOutput, null);
  assert.equal(rows[0]!.cost, null);
});

test("saveAgentTurn stores sanitized output — caller must pre-sanitize (contract)", () => {
  /* The store accepts whatever it receives; the DI contract requires the caller (defaultAgentDeps
     funnel) to sanitize before calling saveAgentTurn. We test that round-trip is faithful.
   */
  const runId = "run-sanitize-rt-" + Date.now();
  const sanitizedText = "[REDACTED] was in the output";
  saveAgentTurn(makeTurn({ runId, outputText: sanitizedText }));
  const rows = getAgentTurns(runId);
  assert.equal(rows[0]!.outputText, sanitizedText);
});

test("two turns of one run from different sessions are both stored and read back in order", () => {
  const runId = "run-migrate-" + Date.now();
  saveAgentTurn(makeTurn({ runId, sessionId: "sess-a" }));
  saveAgentTurn(makeTurn({ runId, sessionId: "sess-b", role: "qa-reviewer" }));
  const rows = getAgentTurns(runId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.sessionId, "sess-a");
  assert.equal(rows[1]!.role, "qa-reviewer");
});

test("the phases a run reached are stored on its record and read back, null for a run that recorded none", () => {
  const withPhases = createRecord({ target: "e2e", app: "hist-phases-a", sha: "abcdef1234", mode: "diff" });
  const without = createRecord({ target: "e2e", app: "hist-phases-a", sha: "abcdef1235", mode: "diff" });
  recordRunPhases(withPhases.id, { furthestPhase: "execute", phaseTimings: { gate: 3, execute: 900 } });

  assert.deepEqual(getRunPhases(withPhases.id), { furthestPhase: "execute", phaseTimings: { gate: 3, execute: 900 } });
  assert.deepEqual(getRunPhases(without.id), { furthestPhase: null, phaseTimings: null });
});

function finishedRun(app: string, verdict: RunOutcome["verdict"], furthestPhase: string | null, errorClass: string | null, at?: string): string {
  const r = createRecord({ target: "e2e", app, sha: "abcdef1234", mode: "diff" });
  updateRecord(r.id, { status: "done", verdict });
  if (furthestPhase) recordRunPhases(r.id, { furthestPhase, phaseTimings: {} });
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

  assert.deepEqual(getRunFunnel({ app }), [
    { furthestPhase: "setup", verdict: "infra-error", errorClass: "E-INFRA", count: 2 },
    { furthestPhase: "generate", verdict: "infra-error", errorClass: "E-STEP-BUDGET", count: 1 },
    { furthestPhase: "learn", verdict: "pass", errorClass: null, count: 2 },
  ]);
});

test("the funnel groups a run that recorded no phase apart, and leaves out runs that have not finished and other apps", () => {
  const app = "hist-funnel-b";
  finishedRun(app, "infra-error", null, null);
  finishedRun("hist-funnel-other", "pass", "learn", null);
  createRecord({ target: "e2e", app, sha: "abcdef1299", mode: "diff" });

  assert.deepEqual(getRunFunnel({ app }), [{ furthestPhase: null, verdict: "infra-error", errorClass: null, count: 1 }]);
});

test("the funnel narrowed by a date leaves out the runs before it, whatever the date's spelling", () => {
  const app = "hist-funnel-c";
  const id = finishedRun(app, "pass", "learn", null);
  const raw = new Database(process.env.HISTORY_DB_PATH!);
  raw.prepare("UPDATE runs SET at = ? WHERE id = ?").run("2026-10-01T12:00:00.000Z", id);
  raw.close();

  assert.equal(getRunFunnel({ app, since: "2026-10-01T12:00:01.000Z" }).length, 0);
  assert.equal(getRunFunnel({ app, since: "2026-10-01T11:59:59.000Z" }).length, 1);
  assert.equal(getRunFunnel({ app, since: "2026-10-01 12:00:01" }).length, 0, "a date without the T compares as a date, not as text");
  assert.equal(getRunFunnel({ app, since: "2026-10-01 11:00" }).length, 1);
});
