import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getHistory } from "../index";

test("a stored outcome that still carries the retired stubbed-state signal is read with the signal and its other fields intact", () => {
  const app = "hist-retired-stubbed-state";
  getHistory().purgeApp(app);
  const dbPath = process.env.HISTORY_DB_PATH ?? join(process.env.QAYABA_ROOT ?? process.cwd(), "data", "qayaba.db");
  const gateSignals = {
    static: true, coverageRatio: 0.9, reviewerApproved: true, reviewerCorrections: [], flaky: false, retries: 0,
    stubbedState: { specFiles: 1, tests: 2, violations: [{ file: "flows/a.spec.ts", kind: "fulfil-without-get-guard" }] },
  };
  const raw = new Database(dbPath);
  try {
    raw.prepare("INSERT INTO run_outcomes (id, app, sha, mode, target, verdict, error_class, gate_signals, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("run-retired-stubbed", app, "abcdef1234", "diff", "e2e", "pass", null, JSON.stringify(gateSignals), "2026-10-31T00:00:00.000Z");
  } finally {
    raw.close();
  }
  try {
    const read = getHistory().learning.getRunOutcome("run-retired-stubbed")!;
    assert.equal(read.verdict, "pass");
    assert.equal(read.gateSignals.coverageRatio, 0.9);
    assert.equal(read.gateSignals.reviewerApproved, true);
    assert.deepEqual((read.gateSignals as Record<string, unknown>)["stubbedState"], gateSignals.stubbedState, "the retired signal is kept as it was stored");
  } finally {
    getHistory().purgeApp(app);
  }
});

test("a stored outcome that still carries the retired value fields and the class E-VALUE-SURVIVED is read with its other fields intact", () => {
  const app = "hist-retired-value-fields";
  getHistory().purgeApp(app);
  const dbPath = process.env.HISTORY_DB_PATH ?? join(process.env.QAYABA_ROOT ?? process.cwd(), "data", "qayaba.db");
  const gateSignals = {
    static: true, coverageRatio: 0.74, reviewerApproved: true, reviewerRationale: "covers the branch", reviewerCorrections: [], flaky: false, retries: 1,
    valueScore: 0.25, valueByCandidate: [{ candidateId: "c1", exposed: 4, killed: 1, ratio: 0.25 }],
    valueStats: { baseline: 6, exposed: 4, killed: 1, failed: 1, flowBreaks: 0 }, mutantCount: 4, killedCount: 1,
    bundleMutation: { applied: 3, killed: 1, survived: [] },
  };
  /* Nothing writes these fields or this class any more: the row is left by a second connection, as an earlier version of the engine left it. */
  const raw = new Database(dbPath);
  try {
    raw.prepare("INSERT INTO run_outcomes (id, app, sha, mode, target, verdict, error_class, gate_signals, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("run-retired-value", app, "abcdef1234", "diff", "e2e", "fail", "E-VALUE-SURVIVED", JSON.stringify(gateSignals), "2026-10-20T00:00:00.000Z");
  } finally {
    raw.close();
  }
  try {
    const listed = getHistory().learning.listRunOutcomes(app).find((o) => o.runId === "run-retired-value")!;
    assert.ok(listed, "the row is listed");
    assert.equal(listed.verdict, "fail");
    assert.equal(listed.errorClass, "E-VALUE-SURVIVED");
    assert.equal(listed.gateSignals.coverageRatio, 0.74);
    assert.equal(listed.gateSignals.reviewerApproved, true);
    assert.equal(listed.gateSignals.retries, 1);
    assert.deepEqual(listed.gateSignals.bundleMutation, { applied: 3, killed: 1, survived: [] });
    assert.deepEqual(getHistory().learning.getRunOutcome("run-retired-value")?.gateSignals.bundleMutation, { applied: 3, killed: 1, survived: [] });
  } finally {
    getHistory().purgeApp(app);
  }
});
