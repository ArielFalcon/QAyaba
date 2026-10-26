/* What the review rounds do next: one test per way a round continues and per way the review ends. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewAction, MAX_REVIEW_ROUNDS, type ReviewTransition } from "@contexts/qa-run-orchestration/domain/review-action.ts";

const judged: Extract<ReviewTransition, { after: "judgment" }> = { after: "judgment", round: 0, maxRounds: MAX_REVIEW_ROUNDS, unavailable: false, parsed: true, executedRed: false, gateApproves: false, unchangedSinceRejection: false };

test("a reviewer that could not be reached ends the run unavailable", () => {
  assert.equal(reviewAction({ ...judged, unavailable: true }), "end-unavailable");
});
test("a verdict that did not parse is rejected without a correction", () => {
  assert.equal(reviewAction({ ...judged, parsed: false }), "reject");
});
test("a reviewer that sees a red spec cannot approve it", () => {
  assert.equal(reviewAction({ ...judged, executedRed: true, gateApproves: true }), "reject");
});
test("an approving gate approves, on any round", () => {
  assert.equal(reviewAction({ ...judged, gateApproves: true }), "approve");
  assert.equal(reviewAction({ ...judged, round: 1, gateApproves: true }), "approve");
});
test("a rejection on the last round is terminal", () => {
  assert.equal(reviewAction({ ...judged, round: MAX_REVIEW_ROUNDS - 1 }), "reject");
});
test("a rejection of specs unchanged since the last one is terminal", () => {
  assert.equal(reviewAction({ ...judged, unchangedSinceRejection: true }), "reject");
});
test("a rejection with a round left earns a correction", () => {
  assert.equal(reviewAction(judged), "correct");
});
test("a correction the contract refused is sent back once, then resolved", () => {
  assert.equal(reviewAction({ after: "attempt", refusedWithViolations: true, retried: 0 }), "correct");
  assert.equal(reviewAction({ after: "attempt", refusedWithViolations: true, retried: 1 }), "resolve");
  assert.equal(reviewAction({ after: "attempt", refusedWithViolations: false, retried: 0 }), "resolve");
});
test("a correction that delivered specs goes to acceptance", () => {
  assert.equal(reviewAction({ after: "correction", produced: true, allWithdrawn: false, disputed: false }), "resolve");
});
test("a correction with no specs and every finding withdrawn approves the reviewed bytes", () => {
  assert.equal(reviewAction({ after: "correction", produced: false, allWithdrawn: true, disputed: true }), "approve");
});
test("a correction with no specs and an unverifiable rebuttal ends the run disputed", () => {
  assert.equal(reviewAction({ after: "correction", produced: false, allWithdrawn: false, disputed: true }), "end-disputed");
});
test("a correction with no specs and nothing withdrawn or disputed rejects", () => {
  assert.equal(reviewAction({ after: "correction", produced: false, allWithdrawn: false, disputed: false }), "reject");
});
test("an accepted correction is judged again; a refused or capped one rejects", () => {
  assert.equal(reviewAction({ after: "acceptance", accepted: true }), "judge");
  assert.equal(reviewAction({ after: "acceptance", accepted: false }), "reject");
});
