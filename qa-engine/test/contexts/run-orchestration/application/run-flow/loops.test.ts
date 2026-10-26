/* The counters of a run's loops start at zero and live in the one place the run's state keeps them. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialRunState } from "@contexts/run-orchestration/application/run-flow/run-state.ts";

test("a new run starts every loop at zero", () => {
  assert.deepEqual(initialRunState().loops, { staticFix: 0, preExecRegen: 0, fixLoop: 0, coverageRegen: 0, reviewRound: 0, reviewAttempt: 0, leadCorrections: 0, leadReviewTurns: 0 });
});

test("two runs never share their counters", () => {
  const first = initialRunState();
  first.loops.staticFix += 1;
  assert.equal(initialRunState().loops.staticFix, 0);
});
