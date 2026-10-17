import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeEvidence } from "@contexts/evaluation/domain/graders.ts";
import { evidence, signals } from "./evidence-fixtures.ts";

const find = (e: ReturnType<typeof evidence>, name: string) => gradeEvidence(e).find((s) => s.name === name);

test("an accepted run that delivered specs and had a reviewer passes the empty-output guard", () => {
  assert.equal(find(evidence(), "empty_output_guard")?.value, true);
});

test("a run that publishes a PR with zero valid specs fails the empty-output guard", () => {
  const score = find(evidence({ specs: { generated: 0, valid: 0, passed: 0 } }), "empty_output_guard");
  assert.equal(score?.value, false);
  assert.match(score?.comment ?? "", /no valid spec/);
});

test("an accepted run with no reviewer verdict and no reviewer turn fails the guard when review was required, and passes when it was not", () => {
  const noReview = { signals: signals({ reviewerApproved: undefined }), reviewerTurns: 0 };
  assert.equal(find(evidence(noReview), "empty_output_guard")?.value, false);
  assert.equal(find(evidence({ ...noReview, reviewRequired: false }), "empty_output_guard")?.value, true);
});

test("a stored reviewer verdict or a reviewer turn shows that the review happened", () => {
  assert.equal(find(evidence({ signals: signals({ reviewerApproved: true }), reviewerTurns: 0 }), "empty_output_guard")?.value, true);
  assert.equal(find(evidence({ signals: signals({ reviewerApproved: undefined }), reviewerTurns: 2 }), "empty_output_guard")?.value, true);
});

test("the guard says nothing when it cannot know: review requirement unrecorded, turn history gone, or validity unknown", () => {
  assert.equal(find(evidence({ reviewRequired: undefined }), "empty_output_guard"), undefined);
  assert.equal(find(evidence({ signals: signals({ reviewerApproved: undefined }), reviewerTurns: undefined }), "empty_output_guard"), undefined);
  assert.equal(find(evidence({ specs: { generated: 2, valid: null, passed: undefined } }), "empty_output_guard"), undefined);
});

test("a run that was not accepted cannot fail the empty-output guard", () => {
  const e = evidence({ verdict: "fail", decision: "issue", specs: { generated: 0, valid: 0, passed: 0 }, reviewerTurns: 0 });
  assert.equal(find(e, "empty_output_guard")?.value, true);
});

test("a context run is not graded for output it never owed", () => {
  assert.equal(find(evidence({ mode: "context", specs: { generated: 0, valid: 0, passed: 0 } }), "empty_output_guard"), undefined);
});

test("a run that has not finished is graded by nothing", () => {
  assert.deepEqual(gradeEvidence(evidence({ finished: false, verdict: null })), []);
});

test("furthest_phase carries the last phase entered, and nothing when none was recorded", () => {
  assert.equal(find(evidence({ furthestPhase: "execute" }), "furthest_phase")?.value, "execute");
  assert.equal(find(evidence({ furthestPhase: null }), "furthest_phase"), undefined);
});

test("spec validity and pass rates are shares, and pass rate is absent when no spec was valid", () => {
  const e = evidence({ specs: { generated: 4, valid: 2, passed: 1 } });
  assert.equal(find(e, "spec_validity_rate")?.value, 0.5);
  assert.equal(find(e, "spec_pass_rate")?.value, 0.5);
  const none = evidence({ verdict: "invalid", decision: "none", furthestPhase: "validate", specs: { generated: 3, valid: 0, passed: 0 } });
  assert.equal(find(none, "spec_validity_rate")?.value, 0);
  assert.equal(find(none, "spec_pass_rate"), undefined);
  assert.equal(find(evidence({ specs: { generated: 0, valid: 0, passed: 0 } }), "spec_validity_rate"), undefined);
});

test("validity is omitted while it is unknown", () => {
  assert.equal(find(evidence({ verdict: "infra-error", furthestPhase: "generate", specs: { generated: 2, valid: null, passed: undefined } }), "spec_validity_rate"), undefined);
});

test("a pass rate needs a run that executed its specs and a passed count it can trust", () => {
  const base = { specs: { generated: 2, valid: 2, passed: 1 } };
  assert.equal(find(evidence({ ...base, furthestPhase: "health" }), "spec_pass_rate"), undefined, "never reached execute");
  assert.equal(find(evidence({ ...base, verdict: "infra-error", furthestPhase: "execute" }), "spec_pass_rate"), undefined, "an infra-error run executed nothing conclusive");
  assert.equal(find(evidence({ ...base, verdict: "fail", furthestPhase: "execute" }), "spec_pass_rate")?.value, 0.5);
  assert.equal(find(evidence({ specs: { generated: 2, valid: 2, passed: undefined } }), "spec_pass_rate"), undefined, "cases not tied to specs");
});

test("budget_exhaustion names the limit, the phase and the role, or none", () => {
  assert.equal(find(evidence(), "budget_exhaustion")?.value, "none");
  const e = evidence({ furthestPhase: "generate", limit: { fired: "step-cap", role: "qa-generator", intent: "explore" } });
  assert.equal(find(e, "budget_exhaustion")?.value, "step-cap@generate/qa-generator/explore");
  const unknown = evidence({ furthestPhase: null, limit: { fired: "run-deadline", role: undefined, intent: undefined } });
  assert.equal(find(unknown, "budget_exhaustion")?.value, "run-deadline@unknown/unknown/unknown");
});

test("an accepted run that a deterministic signal rejected is not approval-consistent", () => {
  assert.equal(find(evidence(), "approval_consistent")?.value, true);
  assert.equal(find(evidence({ signals: signals({ static: false }) }), "approval_consistent")?.value, false);
  assert.equal(find(evidence({ signals: signals({ catalogGateFailClosed: 1 }) }), "approval_consistent")?.value, false);
  assert.equal(find(evidence({ signals: signals({ coverageStatus: "fail", coverageMode: "enforce" }) }), "approval_consistent")?.value, false);
});

test("low coverage only contradicts an approval when the policy enforces it", () => {
  assert.equal(find(evidence({ signals: signals({ coverageStatus: "fail", coverageMode: "signal" }) }), "approval_consistent")?.value, true);
});

test("a run that was not accepted is consistent even when a signal said no", () => {
  const e = evidence({ verdict: "fail", decision: "issue", signals: signals({ static: false }) });
  assert.equal(find(e, "approval_consistent")?.value, true);
});

test("change_coverage is the decision the engine recorded, and a run that recorded none is unknown, never pass", () => {
  assert.equal(find(evidence({ signals: signals({ coverageStatus: "pass" }) }), "change_coverage")?.value, "pass");
  assert.equal(find(evidence({ signals: signals({ coverageStatus: "fail" }) }), "change_coverage")?.value, "fail");
  assert.equal(find(evidence({ signals: signals({ coverageStatus: "unknown" }) }), "change_coverage")?.value, "unknown");
  assert.equal(find(evidence({ signals: signals({ coverageStatus: undefined }) }), "change_coverage")?.value, "unknown");
  assert.equal(find(evidence({ signals: undefined }), "change_coverage"), undefined);
});

test("mutation_value is the kill share and exists only when the oracle ran", () => {
  assert.equal(find(evidence({ signals: signals({ mutantCount: 4, killedCount: 3 }) }), "mutation_value")?.value, 0.75);
  assert.equal(find(evidence(), "mutation_value"), undefined);
  assert.equal(find(evidence({ signals: signals({ mutantCount: 0, killedCount: 0 }) }), "mutation_value"), undefined);
});

test("infra_error carries the error class of an infra-error run and none otherwise", () => {
  assert.equal(find(evidence(), "infra_error")?.value, "none");
  assert.equal(find(evidence({ verdict: "infra-error", decision: "none", errorClass: "E-TIME-BUDGET" }), "infra_error")?.value, "E-TIME-BUDGET");
  assert.equal(find(evidence({ verdict: "infra-error", errorClass: null }), "infra_error")?.value, "unclassified");
});

test("step intent shares add to one and auth_overhead is the auth share", () => {
  const scores = gradeEvidence(evidence({ stepIntents: { auth: 1, explore: 1, write_spec: 2 } }));
  const mix = scores.filter((s) => s.name.startsWith("step_intent_mix."));
  assert.equal(mix.length, 6);
  assert.equal(mix.reduce((sum, s) => sum + (s.value as number), 0), 1);
  assert.equal(scores.find((s) => s.name === "step_intent_mix.write_spec")?.value, 0.5);
  assert.equal(scores.find((s) => s.name === "auth_overhead")?.value, 0.25);
});

test("an intent outside the closed set counts as other, and a run with no step data has no mix", () => {
  const scores = gradeEvidence(evidence({ stepIntents: { weird: 2, auth: 2 } }));
  assert.equal(scores.find((s) => s.name === "step_intent_mix.other")?.value, 0.5);
  assert.equal(gradeEvidence(evidence()).some((s) => s.name.startsWith("step_intent_mix") || s.name === "auth_overhead"), false);
});

test("naming graders runs only those", () => {
  const names = gradeEvidence(evidence({ stepIntents: { auth: 1 } }), ["spec_pass_rate"]).map((s) => s.name);
  assert.deepEqual(names, ["spec_pass_rate"]);
});

test("a cancelled run is graded as cancelled and for nothing else", () => {
  const scores = gradeEvidence(evidence({ cancelled: true, verdict: "infra-error", decision: null, stepIntents: { auth: 1 } }));
  assert.deepEqual(scores.map((s) => [s.name, s.value]), [["infra_error", "cancelled"]]);
});

test("an infra-error run that delivered specs keeps its validity and carries no pass rate", () => {
  const e = evidence({ verdict: "infra-error", errorClass: "E-TIME-BUDGET", decision: "none", furthestPhase: "execute", specs: { generated: 2, valid: 2, passed: undefined }, reviewerTurns: 0 });
  assert.equal(find(e, "spec_validity_rate")?.value, 1);
  assert.equal(find(e, "spec_pass_rate"), undefined);
  assert.equal(find(e, "infra_error")?.value, "E-TIME-BUDGET");
  assert.equal(find(e, "empty_output_guard")?.value, true);
});
