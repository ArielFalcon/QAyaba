import { test } from "node:test";
import assert from "node:assert/strict";
import { leadReviewContract } from "@contexts/coordination/application/lead-review.contract.ts";
import { LEAD_CORRECTION_WIRE, leadCorrectionContract } from "@contexts/coordination/application/lead-correction.contract.ts";
import { FLOW_OUTCOME } from "@contexts/coordination/application/flow-outcomes.ts";
import type { FlowUnderReview } from "@contexts/coordination/application/lead-review.ts";
import { CORRECTION_ORIGIN, type CorrectionFinding, type FlowUnderCorrection } from "@contexts/coordination/application/lead-correction.ts";
import { SUBMIT_TOOL, type SubmissionCheck } from "@kernel/submission.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();

const delivered: FlowUnderReview = {
  id: "cart",
  objective: "the cart total",
  acceptance: [],
  outcome: { id: "cart", kind: FLOW_OUTCOME.DELIVERED, specs: ["flows/cart.spec.ts"] },
  answer: { kind: "read", concerns: [] },
  verified: true,
  sessionOpen: true,
};
const flowsUnderCorrection: FlowUnderCorrection[] = [{ id: "cart", objective: "the cart total", specFile: "flows/cart.spec.ts", sessionOpen: true }];
const findings: CorrectionFinding[] = [{ id: "F1", text: "the total is never asserted", spec: "e2e/flows/cart.spec.ts" }, { id: "F2", text: "a selector is a CSS class" }];

const errorsOf = (check: SubmissionCheck<unknown>): ReadonlyArray<{ path: string; reason: string }> => (check.ok ? [] : check.errors);

test("the review contract refuses what the reader cannot read, naming where, and takes a decision the orchestrator's facts will overrule", () => {
  const contract = leadReviewContract(redaction, [delivered], { revisionsAllowed: true });
  assert.equal(contract.tool, SUBMIT_TOOL.FLOW_REVIEW);
  assert.deepEqual(errorsOf(contract.check({ nothing: true })).map((e) => e.path), ["answer"]);
  const odd = errorsOf(contract.check({ review: [{ flow: "cart", action: "accept" }, { flow: "ghost", action: "drop" }, { flow: "cart", action: "sing" }] }));
  assert.deepEqual(odd.map((e) => e.path), ["review[1]", "review[2]"]);
  assert.match(odd[0]!.reason, /ghost/);
  assert.match(odd[1]!.reason, /sing/);
  assert.equal(contract.check({ review: [{ flow: "cart", action: "drop", reason: "redundant" }] }).ok, true, "a drop of a delivered flow reads; the admission refuses it with its reason");
  assert.equal(contract.check({ review: [] }).ok, true, "a review that names no flow leaves every flow as it is");
});

test("the correction contract refuses what the reader cannot read, naming where, and takes an order the orchestrator's facts will refuse", () => {
  const contract = leadCorrectionContract(redaction, flowsUnderCorrection, findings);
  assert.equal(contract.tool, SUBMIT_TOOL.CORRECTIONS);
  assert.deepEqual(errorsOf(contract.check({})).map((e) => e.path), ["answer"]);
  const odd = errorsOf(contract.check({ corrections: [{ flow: "cart", action: "accept" }, { flow: "ghost", action: "revise" }, { flow: "cart", action: "revise", findings: [9] }] }));
  assert.deepEqual(odd.map((e) => e.path), ["corrections[0]", "corrections[1]", "corrections[2].findings[0]"]);
  assert.match(odd[2]!.reason, /1\.\.2/, "it says which numbers are findings");
  assert.equal(contract.check({ corrections: [{ flow: "cart", action: "revise", findings: [] }] }).ok, true, "an order that names no finding reads; the admission refuses it and the lead is asked once");
  assert.equal(contract.check({ corrections: [] }).ok, true);
  assert.equal(contract.check({ rebuttals: [{ finding: 1, basis: "execution", ref: "cart total" }] }).ok, true);
});

test("the correction contract holds rebuttals to the same reader: a basis outside the contract is refused inside the turn", () => {
  const contract = leadCorrectionContract(redaction, flowsUnderCorrection, findings);
  const refused = errorsOf(contract.check({ rebuttals: [{ finding: 1, basis: "opinion", ref: "x" }] }));
  assert.deepEqual(refused.map((e) => e.path), ["rebuttals[0]"]);
  assert.match(refused[0]!.reason, /opinion/);
});

test("the correction contract holds a decline to the reader inside the turn: a finding that is not a decision's arms and a basis outside the plan's set are refused with where", () => {
  const arms: CorrectionFinding[] = [{ text: "decision on a changed line", file: "src/cart.ts", line: 4, declinable: true }, { text: "changed lines of src/cart.ts", file: "src/cart.ts" }];
  const contract = leadCorrectionContract(redaction, flowsUnderCorrection, arms, CORRECTION_ORIGIN.COVERAGE);

  assert.equal(contract.check({ declines: [{ finding: 1, basis: "needs-unavailable-state", reason: "DEV returns no such response" }] }).ok, true);
  const refused = errorsOf(contract.check({ declines: [{ finding: 2, basis: "needs-unavailable-state", reason: "x" }, { finding: 1, basis: "too-hard", reason: "x" }] }));
  assert.deepEqual(refused.map((e) => e.path), ["declines[0]", "declines[1]"]);
  assert.match(refused[0]!.reason, /decision's arms/);
  assert.match(refused[1]!.reason, /too-hard/);
});

test("the wire schema the tool is generated from types a decline with the plan's bases", () => {
  const valid = { declines: [{ finding: 1, basis: "already-covered", reason: "the suite proves it" }] };

  assert.equal(LEAD_CORRECTION_WIRE.safeParse(valid).success, true);
  assert.equal(LEAD_CORRECTION_WIRE.safeParse({ declines: [{ finding: 1, basis: "tired", reason: "x" }] }).success, false);
  assert.equal(LEAD_CORRECTION_WIRE.safeParse({ declines: [{ finding: 1, basis: "already-covered" }] }).success, false, "a decline states why");
});
