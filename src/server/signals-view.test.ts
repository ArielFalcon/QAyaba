import { test } from "node:test";
import assert from "node:assert/strict";
import { toSignalsView } from "./signals-view";
import type { RunRecord, RunOutcome } from "../types";

function run(verdict: RunRecord["verdict"]): RunRecord {
  return {
    id: "r", app: "a", sha: "s", target: "e2e", mode: "diff",
    status: "done", verdict, cases: [], logs: [], at: "2026-01-01T00:00:00Z",
  };
}

test("toSignalsView reads 'not measured' when no run carried a coverage ratio, and states no value-oracle block", () => {
  const view = toSignalsView([
    { runs: [run("pass"), run("fail"), run("skipped"), run("infra-error"), run(undefined)] },
  ]);
  assert.equal("valueOracle" in view, false);
  assert.equal(view.coverage.measured, false);
  /* Proxy pass-rate counts only quality verdicts: pass + fail (skipped/infra-error/in-flight excluded). */
  assert.equal(view.reviewer.runs, 2);
  assert.equal(view.reviewer.passRate, 0.5);
});

test("toSignalsView pools the quality verdicts of every app", () => {
  const view = toSignalsView([
    { runs: [run("pass")] },
    { runs: [run("pass"), run("fail")] },
  ]);
  assert.equal(view.reviewer.runs, 3);
  assert.equal(view.reviewer.passRate, 0.6667); /* 2/3 rounded to 4 dp, matching coverage.avgRatio */
});

test("toSignalsView aggregates change-coverage across the fleet (null when unmeasured)", () => {
  const outcome = (coverageRatio: number | null): RunOutcome => ({
    runId: "r", app: "a", sha: "s", mode: "diff", target: "e2e", verdict: "pass",
    errorClass: null,
    gateSignals: { static: true, coverageRatio, reviewerCorrections: [], flaky: false, retries: 0 },
at: "2026-01-01T00:00:00Z",
  });
  const view = toSignalsView([
    { runs: [], outcomes: [outcome(0.8), outcome(0.6), outcome(null)] },
  ]);
  assert.equal(view.coverage.measured, true);
  assert.equal(view.coverage.measuredRuns, 2);
  assert.equal(view.coverage.totalRuns, 3);
  assert.equal(view.coverage.avgRatio, 0.7); /* (0.8 + 0.6) / 2, null run ignored */
});
