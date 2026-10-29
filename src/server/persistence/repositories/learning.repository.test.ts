import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getHistory } from "../index";
import type { RunOutcome } from "../../../types";
import { CURRICULUM_CORRUPT } from "@contexts/cross-run-learning/application/index";
import { initCurriculum } from "@contexts/cross-run-learning/application/index";


test("loadScorecard reads the row earlier runs left, reports an app with none as null, and a purge removes it", () => {
  const app = "hist-scorecard-read";
  assert.equal(getHistory().learning.loadScorecard(app), null);
  const scorecard = {
    app,
    updatedAt: "2026-06-13T00:00:00.000Z",
    entries: [{ runId: "r1", app, sha: "abc", target: "e2e", valueScore: 0.5, mutantCount: 4, killedCount: 2, at: "2026-06-13T00:00:00.000Z" }],
    summary: { totalRuns: 1, measuredRuns: 1, avgValueScore: 0.5, lastValueScore: 0.5 },
  };
  /* Nothing writes a scorecard any more: the row is left by a second connection to the same on-disk db, as an earlier version of the engine left it. */
  const dbPath = process.env.HISTORY_DB_PATH ?? join(process.env.QAYABA_ROOT ?? process.cwd(), "data", "qayaba.db");
  const raw = new Database(dbPath);
  try {
    raw.prepare("INSERT INTO scorecard (app, data, updated_at) VALUES (?, ?, ?)").run(app, JSON.stringify(scorecard), scorecard.updatedAt);
  } finally {
    raw.close();
  }

  assert.deepEqual(getHistory().learning.loadScorecard(app), scorecard);

  getHistory().purgeApp(app);
  assert.equal(getHistory().learning.loadScorecard(app), null);
});

test("loadCurriculum: a corrupt row is logged loudly and reported as a distinct fault, never silently treated as absent/fresh", () => {
  const app = `hist-curriculum-corrupt-${Date.now().toString(36)}`;
  getHistory().learning.saveCurriculum(initCurriculum(app));
  assert.ok(getHistory().learning.loadCurriculum(app), "sanity: the valid row round-trips before corruption");

  /* Corrupt the row directly (bypassing saveCurriculum, which only ever writes valid JSON) —
     a second connection to the SAME on-disk db (WAL mode allows this). */
  const dbPath = process.env.HISTORY_DB_PATH ?? join(process.env.QAYABA_ROOT ?? process.cwd(), "data", "qayaba.db");
  const raw = new Database(dbPath);
  try {
    raw.prepare("UPDATE curriculum SET data = ? WHERE app = ?").run("{not valid json", app);
  } finally {
    raw.close();
  }

  const originalWarn = console.warn;
  const logged: string[] = [];
  console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const result = getHistory().learning.loadCurriculum(app);
    assert.equal(result, CURRICULUM_CORRUPT, "a corrupt row must be reported as a distinct fault, never treated as null/absent (which a fold() would silently overwrite with a fresh curriculum)");
    assert.equal(logged.length, 1, "the corrupt row must be logged exactly once, not swallowed silently");
    assert.match(logged[0] ?? "", /corrupt/i, "the log line must be identifiable as a corrupt-curriculum fault");
    assert.match(logged[0] ?? "", new RegExp(app), "the log line must identify which app's row is corrupt");
  } finally {
    console.warn = originalWarn;
  }
});

test("getRunOutcome returns the single run's outcome and round-trips the reviewer verdict", () => {
  const app = "value-report-app";
  getHistory().purgeApp(app); /* self-isolate: the history DB is a module-global singleton */
  try {
    const outcome: RunOutcome = {
      runId: "run-value-1", app, sha: "deadbeef0", mode: "diff", target: "e2e",
      verdict: "pass", errorClass: null,
      gateSignals: { static: true, coverageRatio: 0.82, valueScore: null, reviewerCorrections: [], reviewerRationale: "covers the new validation branch", reviewerApproved: true, flaky: false, retries: 0 },
      at: "2026-06-13T00:00:00.000Z",
    };
    getHistory().learning.saveRunOutcome(outcome);

    const got = getHistory().learning.getRunOutcome("run-value-1");
    assert.ok(got, "expected an outcome for the known runId");
    assert.equal(got!.gateSignals.coverageRatio, 0.82);
    assert.equal(got!.gateSignals.reviewerApproved, true);
    assert.equal(got!.gateSignals.reviewerRationale, "covers the new validation branch");
    assert.equal(getHistory().learning.getRunOutcome("does-not-exist"), undefined);
  } finally {
    getHistory().purgeApp(app);
  }
});

test("a crash reclassifies the outcome the engine persisted, keeping the evidence it carried, and writes one where none was", () => {
  const app = "hist-crashed-class";
  try {
    const withEvidence = getHistory().runs.createRecord({ target: "e2e", app, sha: "abcdef1234", mode: "diff" });
    getHistory().learning.saveRunOutcome({
      runId: withEvidence.id, app, sha: "abcdef1234", mode: "diff", target: "e2e", verdict: "infra-error", errorClass: "E-INFRA",
      gateSignals: { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0, mutantCount: 7 },
      at: "2026-10-19T00:00:00.000Z",
    });

    getHistory().learning.saveCrashedRunOutcome(getHistory().runs.getRecord(withEvidence.id)!, "internal-error");
    const reclassified = getHistory().learning.getRunOutcome(withEvidence.id)!;
    assert.equal(reclassified.errorClass, "internal-error");
    assert.equal(reclassified.verdict, "infra-error");
    assert.equal(reclassified.gateSignals.mutantCount, 7, "the evidence the engine kept is not replaced with a bare row");

    const bare = getHistory().runs.createRecord({ target: "e2e", app, sha: "abcdef1234", mode: "diff" });
    getHistory().learning.saveCrashedRunOutcome(getHistory().runs.getRecord(bare.id)!, "internal-error");
    assert.equal(getHistory().learning.getRunOutcome(bare.id)?.verdict, "infra-error");
    assert.equal(getHistory().learning.getRunOutcome(bare.id)?.errorClass, "internal-error");
  } finally {
    getHistory().purgeApp(app);
  }
});