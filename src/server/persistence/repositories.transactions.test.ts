import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHistoryDatabase } from "./database";
import { createHistory } from "./index";

/* Every mutating method of a repository writes inside a transaction: the statements SQLite runs, recorded with the transaction flag. */
function instrumented(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "history-tx-"));
  const writes: Array<{ sql: string; inTransaction: boolean }> = [];
  const db = openHistoryDatabase(join(dir, "history.db"), {
    onStatement: (sql, inTransaction) => {
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) writes.push({ sql, inTransaction });
    },
  });
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { history: createHistory(db), writes };
}

test("the context repository writes only inside transactions", (t) => {
  const { history, writes } = instrumented(t);
  history.contexts.markContextStale("app");
  history.contexts.clearContextStale("app");
  history.contexts.recordContextHealRequest("app");
  history.contexts.saveContextMap("app", "abcdef1", { builtAtSha: "abcdef1", routes: [], api: [], feBe: [] });

  assert.equal(writes.length, 4);
  assert.deepEqual(writes.filter((w) => !w.inTransaction), []);
});

test("the judge repository writes only inside transactions", (t) => {
  const { history, writes } = instrumented(t);
  history.judges.insertJudgeAttempt({ runId: "r", judge: "j", promptVersion: "v1", model: null, outcome: "scored", tokens: 1, detail: null, at: "2026-10-01T00:00:00.000Z" });
  history.judges.insertJudgeCalibration({
    judge: "j", promptVersion: "v1", model: "m", trainN: 1, devN: 1, testN: 1, tpr: null, tnr: null, agreement: null, status: "ok", report: "{}", computedAt: "2026-10-01T00:00:00.000Z",
  });

  assert.equal(writes.length, 2);
  assert.deepEqual(writes.filter((w) => !w.inTransaction), []);
});

test("the evaluation repository writes only inside transactions", (t) => {
  const { history, writes } = instrumented(t);
  const score = { runId: "r", name: "n", graderVersion: "g1", dataType: "NUMERIC", polarity: "higher", source: "code", value: 1, comment: null, observationId: null };
  history.evaluations.replaceRunScores([score], "2026-10-01T00:00:00.000Z", { runId: "r", graderVersion: "g1" });
  history.evaluations.setRunEvaluationStatus("r", "complete", "2026-10-01T00:00:00.000Z");
  history.evaluations.saveRegradeJob({ jobId: "j", status: "pending", runIds: ["r"], graders: null, runs: 1, graded: 0, failed: [], startedAt: "2026-10-01T00:00:00.000Z", finishedAt: null });
  history.evaluations.failInterruptedRegradeJobs("2026-10-01T00:00:01.000Z");

  assert.ok(writes.length >= 4);
  assert.deepEqual(writes.filter((w) => !w.inTransaction), []);
});

test("the learning repository writes only inside transactions", (t) => {
  const { history, writes } = instrumented(t);
  const learning = history.learning;
  learning.upsertLearningRule({ id: "rule-1", app: "app", trigger: "t", action: "a", errorClass: "E-INFRA", source: "test" } as never);
  learning.incrementRuleUsage(["rule-1"]);
  learning.recordRuleOutcome("rule-1", 1);
  learning.setRuleStatusByHuman("rule-1", "active");
  learning.quarantineLearningRules("app", ["rule-1"], "2026-10-01T00:00:00.000Z");
  learning.releaseLearningRuleQuarantine("rule-1");
  learning.saveCurriculum({ app: "app", updatedAt: "2026-10-01T00:00:00.000Z" } as never);
  learning.saveScorecardEntry({ app: "app", runId: "r", at: "2026-10-01T00:00:00.000Z", valueScore: 1 } as never);
  learning.saveRunOutcome({ runId: "r", app: "app", sha: "abcdef1", mode: "diff", target: "e2e", verdict: "pass", errorClass: null, gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 }, rulesRetrieved: [], at: "2026-10-01T00:00:00.000Z" });
  learning.updateRunOutcomeReflection("r", {} as never);

  assert.ok(writes.length >= 9);
  assert.deepEqual(writes.filter((w) => !w.inTransaction), []);
});

test("the telemetry repository writes only inside transactions", (t) => {
  const { history, writes } = instrumented(t);
  history.telemetry.commitRunSpans([
    { traceId: "t", spanId: "s", parentSpanId: null, runId: null, name: "n", kind: "internal", startNs: 1n, endNs: null, status: "unset", statusMessage: null, attrs: "{}", events: "[]", links: "[]" },
  ]);
  history.telemetry.saveAgentTurn({
    runId: null, sessionId: "s", role: "qa-author", round: 0, isRepair: false, ts: "2026-10-01T00:00:00.000Z", objective: null, promptText: "p", outputText: "o", promptBytes: 1,
    tokensInput: null, tokensOutput: null, tokensReasoning: null, tokensCacheRead: null, tokensCacheWrite: null, cost: null,
  });

  assert.equal(writes.length, 2);
  assert.deepEqual(writes.filter((w) => !w.inTransaction), []);
});

test("the run repository writes only inside transactions", (t) => {
  const { history, writes } = instrumented(t);
  const runs = history.runs;
  const run = runs.createRecord({ app: "app", sha: "abcdef1234", target: "e2e", mode: "diff" });
  runs.updateRecord(run.id, { status: "running", step: "generate", specs: [{ name: "a.spec.ts" }] });
  runs.addCase(run.id, { name: "case", status: "pass" });
  runs.appendLog(run.id, "line");
  runs.appendActivity(run.id, { kind: "command", text: "x" });
  runs.recordRunPhases(run.id, { furthestPhase: "setup", phaseTimings: {} });
  runs.recordEffectiveConfig(run.id, "{}");
  runs.saveRunEvent({ runId: run.id, seq: 0, ts: 1, body: {} });
  runs.commitSpecSnapshots([{ runId: run.id, path: "a", sha256: "s", text: "t", bytes: 1, capturedAt: 1, delivered: 1 }]);
  runs.commitRunPlan(run.id, "{}", 1);
  history.purgeApp("app");
  runs.clearDatabase();

  assert.ok(writes.length >= 12);
  assert.deepEqual(writes.filter((w) => !w.inTransaction), []);
});
