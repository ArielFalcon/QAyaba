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

test("an accepted run without a reviewer turn fails the guard unless review was turned off", () => {
  assert.equal(find(evidence({ reviewerTurns: 0 }), "empty_output_guard")?.value, false);
  assert.equal(find(evidence({ reviewerTurns: 0, reviewRequired: false }), "empty_output_guard")?.value, true);
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
  const none = evidence({ specs: { generated: 3, valid: 0, passed: 0 } });
  assert.equal(find(none, "spec_validity_rate")?.value, 0);
  assert.equal(find(none, "spec_pass_rate"), undefined);
  assert.equal(find(evidence({ specs: { generated: 0, valid: 0, passed: 0 } }), "spec_validity_rate"), undefined);
});

test("budget_exhaustion names the limit, the phase and the role, or none", () => {
  assert.equal(find(evidence(), "budget_exhaustion")?.value, "none");
  const e = evidence({ furthestPhase: "generate", limit: { fired: "step-cap", role: "qa-generator" } });
  assert.equal(find(e, "budget_exhaustion")?.value, "step-cap@generate/qa-generator");
});

test("an accepted run that a deterministic signal rejected is not approval-consistent", () => {
  assert.equal(find(evidence(), "approval_consistent")?.value, true);
  assert.equal(find(evidence({ signals: signals({ static: false }) }), "approval_consistent")?.value, false);
  assert.equal(find(evidence({ signals: signals({ catalogGateFailClosed: 1 }) }), "approval_consistent")?.value, false);
  assert.equal(find(evidence({ signals: signals({ coverageRatio: 0.1, coverageMode: "enforce" }) }), "approval_consistent")?.value, false);
});

test("low coverage only contradicts an approval when the policy enforces it", () => {
  assert.equal(find(evidence({ signals: signals({ coverageRatio: 0.1, coverageMode: "signal" }) }), "approval_consistent")?.value, true);
});

test("a run that was not accepted is consistent even when a signal said no", () => {
  const e = evidence({ verdict: "fail", decision: "issue", signals: signals({ static: false }) });
  assert.equal(find(e, "approval_consistent")?.value, true);
});

test("change_coverage is pass or fail against the threshold, and an unmeasured run is unknown, never pass", () => {
  assert.equal(find(evidence({ signals: signals({ coverageRatio: 0.7 }) }), "change_coverage")?.value, "pass");
  assert.equal(find(evidence({ signals: signals({ coverageRatio: 0.69 }) }), "change_coverage")?.value, "fail");
  assert.equal(find(evidence({ signals: signals({ coverageRatio: null }) }), "change_coverage")?.value, "unknown");
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
