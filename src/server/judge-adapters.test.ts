import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteCalibrationPairs, SqliteCalibrationStore, SqliteJudgeLedger } from "./judge-adapters";
import { SqliteScoreStore } from "./evaluation-service";
import { calibrate } from "@contexts/evaluation/application/index";
import { judgeDefinition, judgeGraderVersion, judgeScore } from "@contexts/evaluation/application/index";
import { getHistory } from "./persistence/index";

const AT = "2026-10-18T10:00:00.000Z";
const attempt = (over: Partial<Parameters<SqliteJudgeLedger["record"]>[0]> = {}) => ({
  runId: "run-l1",
  judge: "spec_relevance" as const,
  promptVersion: "1",
  model: "m",
  outcome: "scored" as const,
  tokens: 100,
  detail: null,
  at: AT,
  ...over,
});

test("the ledger remembers the newest outcome of a (run, judge, prompt version) and sums a UTC day's tokens", () => {
  const ledger = new SqliteJudgeLedger();
  ledger.record(attempt({ runId: "run-l2", outcome: "error", tokens: 5 }));
  ledger.record(attempt({ runId: "run-l2", outcome: "scored", tokens: 70 }));
  ledger.record(attempt({ runId: "run-l2", promptVersion: "2", outcome: "unparseable", tokens: 30 }));
  assert.equal(ledger.lastOutcome("run-l2", "spec_relevance", "1"), "scored");
  assert.equal(ledger.lastOutcome("run-l2", "spec_relevance", "2"), "unparseable");
  assert.equal(ledger.lastOutcome("run-l2", "failure_root_cause", "1"), undefined);
  ledger.record(attempt({ runId: "run-l3", tokens: 1000, at: "2026-10-19T00:00:01.000Z" }));
  assert.equal(ledger.tokensUsedOn("2026-10-19"), 1000);
  assert.ok(ledger.tokensUsedOn("2026-10-18") >= 105);
});

test("the ledger knows the model of the newest scored attempt of a prompt version, ignoring attempts that scored nothing", () => {
  const ledger = new SqliteJudgeLedger();
  ledger.record(attempt({ runId: "run-m1", judge: "failure_root_cause", model: "p/old" }));
  ledger.record(attempt({ runId: "run-m2", judge: "failure_root_cause", model: "p/new" }));
  ledger.record(attempt({ runId: "run-m3", judge: "failure_root_cause", model: "p/ignored", outcome: "unparseable" }));
  assert.equal(ledger.latestModel("failure_root_cause", "1"), "p/new");
  assert.equal(ledger.latestModel("failure_root_cause", "9"), undefined);
});

test("a judge score keeps the model that answered through the score store, and a deterministic score has none", () => {
  const store = new SqliteScoreStore();
  const def = judgeDefinition("spec_relevance");
  const parsed = { ok: true as const, value: true, critique: "relevant" };
  store.replace("run-s1", [judgeScore(def, parsed, { promptVersion: "1", model: "p/m" })], AT, { graderVersion: judgeGraderVersion("spec_relevance", "1"), baseNames: ["spec_relevance"] });
  const [score] = store.list("run-s1", { allVersions: true });
  assert.equal(score?.judgeModel, "p/m");
  assert.equal(score?.source, "llm_judge");
});

test("the default view of a run's scores carries a judge score under its own grader version beside the graders'", () => {
  const store = new SqliteScoreStore();
  const def = judgeDefinition("spec_relevance");
  store.replace("run-s2", [{ name: "spec_validity_rate", value: 1, dataType: "NUMERIC", polarity: "higher_better", source: "deterministic", graderVersion: "1" }], AT, { graderVersion: "1" });
  store.replace("run-s2", [judgeScore(def, { ok: true, value: false, critique: "x" }, { promptVersion: "1", model: "m" })], AT, { graderVersion: judgeGraderVersion("spec_relevance", "1"), baseNames: ["spec_relevance"] });
  // a later deterministic regrade must not delete the judge row
  store.replace("run-s2", [], AT, { graderVersion: "1" });
  assert.deepEqual(store.list("run-s2", { allVersions: false }).map((s) => s.name), ["spec_relevance"]);
});

test("calibration pairs join the newest judge scores with the human labels of the same runs only", () => {
  const def = judgeDefinition("spec_relevance");
  const store = new SqliteScoreStore();
  for (const [run, judge, human] of [["run-p1", true, true], ["run-p2", false, true], ["run-p3", true, undefined]] as const) {
    store.replace(run, [judgeScore(def, { ok: true, value: judge, critique: "c" }, { promptVersion: "2", model: "p/m" })], AT, { graderVersion: judgeGraderVersion("spec_relevance", "2"), baseNames: ["spec_relevance"] });
    if (human !== undefined) {
      getHistory().evaluations.replaceRunScores([{ runId: run, name: "spec_relevance", graderVersion: "human", dataType: "BOOLEAN", polarity: "higher_better", source: "human", value: human, comment: null, observationId: null }], AT);
    }
  }
  const found = new SqliteCalibrationPairs().pairsFor("spec_relevance");
  assert.ok(found);
  assert.equal(found.promptVersion, "2");
  assert.equal(found.model, "p/m");
  assert.deepEqual(found.pairs.map((p) => [p.runId, p.human, p.judge]).sort(), [["run-p1", true, true], ["run-p2", true, false]]);
  assert.equal(new SqliteCalibrationPairs().pairsFor("failure_root_cause"), undefined);
});

test("a calibration report round-trips and the newest one of a prompt version is the one in force", () => {
  const store = new SqliteCalibrationStore();
  const def = judgeDefinition("failure_root_cause");
  const first = calibrate(def, [], { promptVersion: "7", model: "m", computedAt: "2026-10-18T09:00:00.000Z" });
  const second = { ...first, computedAt: "2026-10-18T11:00:00.000Z" };
  store.save(first);
  store.save(second);
  const latest = store.latest("failure_root_cause", "7");
  assert.equal(latest?.computedAt, second.computedAt);
  assert.equal(latest?.status, "experimental");
  assert.equal(store.latest("failure_root_cause", "8"), undefined);
});
