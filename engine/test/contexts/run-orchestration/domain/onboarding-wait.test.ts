import { test } from "node:test";
import assert from "node:assert/strict";
import { ONBOARDING_WAIT_MAX_MS, onboardingWaitStep } from "@contexts/run-orchestration/domain/onboarding-wait.ts";

test("a run waits for onboarding until an operator cancels it or the ceiling is passed", () => {
  assert.equal(onboardingWaitStep(true, 0, 10), "cancelled");
  assert.equal(onboardingWaitStep(true, 99, 10), "cancelled", "a cancel wins over the ceiling");
  assert.equal(onboardingWaitStep(false, 10, 10), "keep-waiting", "the ceiling itself is still inside the wait");
  assert.equal(onboardingWaitStep(false, 11, 10), "give-up");
  assert.equal(ONBOARDING_WAIT_MAX_MS, 40 * 60 * 1000);
});
