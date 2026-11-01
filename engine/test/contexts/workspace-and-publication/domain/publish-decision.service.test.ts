import { test } from "node:test";
import assert from "node:assert/strict";
import { PublishDecisionService } from "@contexts/workspace-and-publication/domain/publish-decision.service.ts";

const svc = new PublishDecisionService();
const base = { reviewerApproved: true, coverageBlocks: false, shadow: false, e2eChanged: true };

test("green + approved + not blocked + changes → pr", () => {
  assert.equal(svc.decide({ ...base, verdict: "pass" }).outcome, "pr");
});
test("green + approved but no e2e changes → noop", () => {
  assert.equal(svc.decide({ ...base, verdict: "pass", e2eChanged: false }).outcome, "noop");
});
test("green but reviewer rejected → issue", () => {
  assert.equal(svc.decide({ ...base, verdict: "pass", reviewerApproved: false }).outcome, "issue");
});
/* The two are one outcome and two facts: a rejection the reviewer gave, and a review that never reached a verdict (nobody approved). */
test("a green run with no reviewer verdict is never published on an approval nobody gave, and says so", () => {
  const decided = svc.decide({ ...base, verdict: "pass", reviewerApproved: undefined });
  assert.equal(decided.outcome, "issue");
  assert.match(decided.reason, /no reviewer verdict/);
  assert.doesNotMatch(decided.reason, /rejected/);
});
test("green but coverage enforce-blocks → held (nothing is opened in the app's repository)", () => {
  assert.equal(svc.decide({ ...base, verdict: "pass", coverageBlocks: true }).outcome, "held");
});
test("a coverage block holds only an approved green run: a rejected one still opens its Issue, the other verdicts keep their outcome", () => {
  assert.equal(svc.decide({ ...base, verdict: "pass", coverageBlocks: true, reviewerApproved: false }).outcome, "issue");
  assert.equal(svc.decide({ ...base, verdict: "fail", coverageBlocks: true }).outcome, "issue");
  assert.equal(svc.decide({ ...base, verdict: "flaky", coverageBlocks: true }).outcome, "quarantine");
  assert.equal(svc.decide({ ...base, verdict: "infra-error", coverageBlocks: true }).outcome, "noop");
});
test("fail or invalid → issue", () => {
  assert.equal(svc.decide({ ...base, verdict: "fail" }).outcome, "issue");
  assert.equal(svc.decide({ ...base, verdict: "invalid" }).outcome, "issue");
});
test("flaky → quarantine", () => {
  assert.equal(svc.decide({ ...base, verdict: "flaky" }).outcome, "quarantine");
});
test("infra-error → noop (no side effect; not a code bug)", () => {
  assert.equal(svc.decide({ ...base, verdict: "infra-error" }).outcome, "noop");
});
/* An infra-error can be an outage or an engine-side condition (an agent that ran out of steps): its reason never names one cause. */
test("the infra-error reason does not blame the DEV environment", () => {
  assert.doesNotMatch(svc.decide({ ...base, verdict: "infra-error" }).reason, /dev\b/i);
});
test("shadow mode overrides every side-effecting outcome to shadow", () => {
  assert.equal(svc.decide({ ...base, verdict: "pass", shadow: true }).outcome, "shadow");
  assert.equal(svc.decide({ ...base, verdict: "fail", shadow: true }).outcome, "shadow");
});
/* skipped must be a noop (the agent approved with zero specs — a clean exit,
   not an error; opening an issue for a skipped run would be a false positive).
 */
test("skipped → noop (agent approved zero specs — clean exit, not an error)", () => {
  assert.equal(svc.decide({ ...base, verdict: "skipped" }).outcome, "noop");
});
/* PublishDecisionService does not own infra-error notification (alert channel, retry logic).
   An infra-error verdict maps to noop here.
 */

test("a defect found opens an Issue for a flaky run, an infra-error and a skip, which would otherwise open nothing, and shadow still replaces it", () => {
  for (const verdict of ["flaky", "infra-error", "skipped"] as const) {
    assert.equal(svc.decide({ ...base, verdict, defectFound: true }).outcome, "issue", verdict);
    assert.equal(svc.decide({ ...base, verdict, defectFound: true, shadow: true }).outcome, "shadow", verdict);
  }
});
