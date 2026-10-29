import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldDistillLearning } from "@contexts/cross-run-learning/domain/should-distill-learning.ts";

/* The adjudicator's class of the failure decides: distilling a "fix this test" rule for a test that
   correctly caught a real app bug would teach the engine to weaken a test that did its job.
 */

test("shouldDistillLearning: adjudicationClass=app_defect — suppressed", () => {
  assert.equal(shouldDistillLearning("app_defect"), false);
});

test("shouldDistillLearning: adjudicationClass=generated_test_defect — still feeds learning (not app_defect)", () => {
  assert.equal(shouldDistillLearning("generated_test_defect"), true);
});

test("shouldDistillLearning: adjudicationClass=undefined — feeds learning", () => {
  assert.equal(shouldDistillLearning(undefined), true);
});

test("shouldDistillLearning: adjudicationClass=runner_infra — does NOT suppress on its own (guard is keyed ONLY on app_defect and dev_not_rendered)", () => {
  assert.equal(shouldDistillLearning("runner_infra"), true);
});

test("shouldDistillLearning: adjudicationClass=dev_infra — does NOT suppress on its own", () => {
  assert.equal(shouldDistillLearning("dev_infra"), true);
});

test("shouldDistillLearning: adjudicationClass=dev_not_rendered — suppressed (a change DEV did not render teaches nothing about the test)", () => {
  assert.equal(shouldDistillLearning("dev_not_rendered"), false);
});

test("shouldDistillLearning: adjudicationClass=objective_gap — does NOT suppress on its own", () => {
  assert.equal(shouldDistillLearning("objective_gap"), true);
});
