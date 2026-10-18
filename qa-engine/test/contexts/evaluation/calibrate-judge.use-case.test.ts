import { test } from "node:test";
import assert from "node:assert/strict";
import { CalibrateJudgeUseCase } from "@contexts/evaluation/application/calibrate-judge.use-case.ts";
import { DEFAULT_CALIBRATION, splitOfRun } from "@contexts/evaluation/domain/judge-calibration.ts";
import { MemoryCalibrations, MemoryPairs } from "./judge-fakes.ts";

const NOW = "2026-10-18T10:00:00.000Z";

function testRunIds(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) if (splitOfRun(`r-${i}`) === "test") out.push(`r-${i}`);
  return out;
}

test("calibrating a judge reports on its newest scores, persists the report and returns it", () => {
  const ids = testRunIds(40);
  const pairs = ids.map((runId, i) => ({ runId, human: i < 20, judge: i < 20 }));
  const store = new MemoryCalibrations();
  const uc = new CalibrateJudgeUseCase({ pairs: new MemoryPairs({ spec_relevance: { graderVersion: "judge-spec_relevance@3", promptVersion: "3", model: "p/m", pairs } }), store, now: () => NOW });
  const outcome = uc.execute({ judge: "spec_relevance" });
  assert.ok(outcome.ok);
  assert.equal(outcome.report.status, "calibrated");
  assert.equal(outcome.report.promptVersion, "3");
  assert.equal(outcome.report.model, "p/m");
  assert.equal(outcome.report.computedAt, NOW);
  assert.equal(store.latest("spec_relevance", "3")?.status, "calibrated");
});

test("--min-n overrides the per-class minimum and the rest of the thresholds keep their defaults", () => {
  const ids = testRunIds(24);
  const pairs = ids.map((runId, i) => ({ runId, human: i < 12, judge: i < 12 }));
  const make = (minN?: number) => {
    const store = new MemoryCalibrations();
    const uc = new CalibrateJudgeUseCase({ pairs: new MemoryPairs({ spec_relevance: { graderVersion: "judge-spec_relevance@1", promptVersion: "1", model: "m", pairs } }), store, now: () => NOW });
    const outcome = uc.execute({ judge: "spec_relevance", ...(minN !== undefined ? { minN } : {}) });
    assert.ok(outcome.ok);
    return outcome.report;
  };
  assert.equal(make().status, "experimental");
  assert.equal(make().thresholds.minN, DEFAULT_CALIBRATION.minN);
  assert.equal(make(10).status, "calibrated");
  assert.equal(make(10).thresholds.minTpr, DEFAULT_CALIBRATION.minTpr);
});

test("a judge with no scores to compare cannot be calibrated and nothing is persisted", () => {
  const store = new MemoryCalibrations();
  const uc = new CalibrateJudgeUseCase({ pairs: new MemoryPairs({}), store, now: () => NOW });
  const outcome = uc.execute({ judge: "failure_root_cause" });
  assert.equal(outcome.ok, false);
  assert.equal(store.reports.length, 0);
});

test("an invalid minimum is refused instead of silently calibrating on nothing", () => {
  const uc = new CalibrateJudgeUseCase({ pairs: new MemoryPairs({}), store: new MemoryCalibrations(), now: () => NOW });
  for (const minN of [0, -1, 1.5, Number.NaN]) assert.throws(() => uc.execute({ judge: "spec_relevance", minN }), /min-n/);
});
