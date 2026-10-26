/* What the fix loop does next: one test per way it carries on and per way it stops. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fixLoopAction, type FixLoopTransition } from "@contexts/run-orchestration/domain/fix-loop-action.ts";
import { ADJ_ACTION } from "@contexts/run-orchestration/domain/adjudicate.service.ts";

const start: FixLoopTransition = { after: "round-start", retry: 0, maxRetries: 2, verdict: "fail", generating: true };
const regen = { after: "regeneration", claim: "none", delivered: 1, absentTargets: false, isCode: false, accepting: true } as const;

test("a failing run with a retry left and a generator goes to triage", () => {
  assert.deepEqual(fixLoopAction(start), { go: "triage" });
});
test("the loop stops when no retry is left", () => {
  assert.deepEqual(fixLoopAction({ ...start, retry: 2 } as FixLoopTransition), { stop: "retries-spent" });
});
test("the loop stops when the verdict is not a failure", () => {
  assert.deepEqual(fixLoopAction({ ...start, verdict: "pass" } as FixLoopTransition), { stop: "no-failure-to-fix" });
});
test("the loop stops when the run does not generate", () => {
  assert.deepEqual(fixLoopAction({ ...start, generating: false } as FixLoopTransition), { stop: "not-generating" });
});
test("a failure that passes on the second read ends the loop", () => {
  assert.deepEqual(fixLoopAction({ after: "triage", passed: true }), { stop: "triage-passed" });
  assert.deepEqual(fixLoopAction({ after: "triage", passed: false }), { go: "adjudicate" });
});
test("an adjudication that is not continue ends the loop", () => {
  assert.deepEqual(fixLoopAction({ after: "adjudication", action: ADJ_ACTION.BREAK_ISSUE, regenerate: true }), { stop: "adjudicated-to-an-issue" });
  assert.deepEqual(fixLoopAction({ after: "adjudication", action: ADJ_ACTION.BREAK_NEEDS_HUMAN, regenerate: true }), { stop: "adjudicated-to-an-issue" });
});
test("a continue adjudication regenerates unless regeneration is retired", () => {
  assert.deepEqual(fixLoopAction({ after: "adjudication", action: ADJ_ACTION.CONTINUE, regenerate: true }), { go: "regenerate" });
  assert.deepEqual(fixLoopAction({ after: "adjudication", action: ADJ_ACTION.CONTINUE, regenerate: false }), { stop: "regeneration-retired" });
});
test("a verified test-correct claim ends the loop", () => {
  assert.deepEqual(fixLoopAction({ ...regen, claim: "verified" }), { stop: "test-correct-claim-verified" });
});
test("a rejected claim earns another round", () => {
  assert.deepEqual(fixLoopAction({ ...regen, claim: "rejected" }), { go: "triage", again: true });
});
test("a regeneration that delivers no specs ends the loop", () => {
  assert.deepEqual(fixLoopAction({ ...regen, delivered: 0 }), { stop: "no-fix-delivered" });
});
test("absent selectors regenerate again without executing", () => {
  assert.deepEqual(fixLoopAction({ ...regen, absentTargets: true }), { go: "triage", again: true });
});
test("an e2e round with an acceptance goes to accept, otherwise to re-execution", () => {
  assert.deepEqual(fixLoopAction(regen), { go: "accept" });
  assert.deepEqual(fixLoopAction({ ...regen, accepting: false }), { go: "reexecute" });
  assert.deepEqual(fixLoopAction({ ...regen, isCode: true }), { go: "reexecute" });
});
test("an unhealthy DEV stops the loop before an execution", () => {
  assert.deepEqual(fixLoopAction({ after: "dev-check", healthy: false, then: "accept" }), { stop: "dev-unhealthy" });
  assert.deepEqual(fixLoopAction({ after: "dev-check", healthy: true, then: "accept" }), { go: "accept" });
  assert.deepEqual(fixLoopAction({ after: "dev-check", healthy: true, then: "reexecute" }), { go: "reexecute" });
});
test("a failed revalidation ends the loop", () => {
  assert.deepEqual(fixLoopAction({ after: "revalidation", ok: false }), { stop: "revalidation-failed" });
  assert.deepEqual(fixLoopAction({ after: "revalidation", ok: true }), { go: "reexecute" });
});
test("an acceptance: accepted continues, rejected with deltas continues, rejected without ends, cap ends", () => {
  assert.deepEqual(fixLoopAction({ after: "acceptance", kind: "accepted", violations: false }), { go: "triage", again: true });
  assert.deepEqual(fixLoopAction({ after: "acceptance", kind: "rejected", violations: true }), { go: "triage", again: true });
  assert.deepEqual(fixLoopAction({ after: "acceptance", kind: "rejected", violations: false }), { stop: "round-rejected" });
  assert.deepEqual(fixLoopAction({ after: "acceptance", kind: "cap", violations: false }), { stop: "round-capped" });
});
test("a re-execution that failed with DEV down ends the loop, otherwise the next round begins", () => {
  assert.deepEqual(fixLoopAction({ after: "reexecution", failed: true, devHealthy: false }), { stop: "dev-failed-under-the-run" });
  assert.deepEqual(fixLoopAction({ after: "reexecution", failed: true, devHealthy: true }), { go: "triage", again: true });
  assert.deepEqual(fixLoopAction({ after: "reexecution", failed: false, devHealthy: false }), { go: "triage", again: true });
});
