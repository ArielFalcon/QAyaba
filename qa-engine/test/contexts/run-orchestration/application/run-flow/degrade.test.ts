/* Where a run goes on from a step whose fault the policy degrades: what is proven is kept, unless the approval it needs is missing. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { degradeFailedStep } from "@contexts/run-orchestration/application/run-flow/degrade.ts";
import { runEnd } from "@contexts/run-orchestration/application/run-flow/run-end.ts";
import { initialRunState } from "@contexts/run-orchestration/application/run-flow/run-state.ts";
import { recordDegradation } from "@contexts/run-orchestration/application/run-flow/reducers.ts";
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";

const spent = new RunDeadlineExceededError(600_000, "diff-tiny", "reviewer", "mid-turn");
const facts = (reviewRequired: boolean) => ({ reviewRequired, endOf: (reason: string) => runEnd("setup-failed", { note: reason }) });

test("a spent deadline after a proven suite goes on to the final proof guard and says so on the outcome", () => {
  const state = initialRunState();
  const outcome = degradeFailedStep("deadline-after-proof", spent, "regenerate-for-coverage", state, facts(false));
  assert.deepEqual(outcome, { goto: "guard-final-proof" });
  assert.deepEqual(state.run.degradations, [{ reason: "deadline-after-proof", note: "the run deadline was spent during regenerate-for-coverage; the suite that ran green on its final bytes is kept" }]);
  assert.deepEqual(state.run.limits, [{ fired: "run-deadline", role: "reviewer", scope: "run" }]);
});

test("a required review that has not given its verdict proves nothing about approval: the run ends on the deadline, and nothing is recorded as kept", () => {
  const state = initialRunState();
  const outcome = degradeFailedStep("deadline-after-proof", spent, "review-round", state, facts(true));
  assert.deepEqual(outcome, { end: runEnd("setup-failed", { note: "run-deadline" }) });
  assert.deepEqual(state.run.degradations, []);
});

test("a verdict that stands, approved or rejected, is kept when the deadline is spent later", () => {
  for (const approved of [true, false]) {
    const state = initialRunState();
    state.review = { ...state.review, reviewerApprovedForOutcome: approved };
    const outcome = degradeFailedStep("deadline-after-proof", spent, "remeasure-stale-coverage", state, facts(true));
    assert.ok(outcome && "goto" in outcome && outcome.goto === "guard-final-proof", `approved ${approved}`);
  }
});

test("a degradation joins the ones the run already carries", () => {
  const state = initialRunState();
  recordDegradation(state, { reason: "publication-failed", note: "earlier" });
  const outcome = degradeFailedStep("deadline-after-proof", spent, "remeasure-stale-coverage", state, facts(false));
  assert.ok(outcome && "goto" in outcome);
  assert.deepEqual(state.run.degradations.map((d) => d.reason), ["publication-failed", "deadline-after-proof"]);
});

test("the same degradation recorded again is the same fact, and one with another sentence is another", () => {
  const state = initialRunState();
  recordDegradation(state, { reason: "regeneration-skipped", note: "no time was left for the coverage regeneration" });
  recordDegradation(state, { reason: "regeneration-skipped", note: "no time was left for the coverage regeneration" });
  recordDegradation(state, { reason: "regeneration-skipped", note: "no time was left for the flaky regeneration" });
  assert.deepEqual(state.run.degradations.map((d) => d.note), ["no time was left for the coverage regeneration", "no time was left for the flaky regeneration"]);
});
