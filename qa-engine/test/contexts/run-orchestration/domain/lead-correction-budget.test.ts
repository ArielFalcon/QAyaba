/* How many corrections a run routes through the lead, and when it stops routing them. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { leadCorrectionAction, leadCorrectionBudget } from "@contexts/run-orchestration/domain/lead-correction-budget.ts";
import { MAX_STATIC_FIX_ROUNDS } from "@kernel/derive-cycle-backstop.ts";
import { MAX_REVIEW_ROUNDS } from "@contexts/run-orchestration/domain/review-action.ts";
import { MAX_PRE_EXEC_REGENERATIONS } from "@contexts/run-orchestration/domain/pre-exec-regen.ts";
import { MAX_COVERAGE_REGENERATIONS } from "@contexts/run-orchestration/domain/coverage-regen.ts";

test("the budget is the sum of the caps of every loop that corrects through the lead", () => {
  const maxRetries = 3;
  /* Each review round may correct twice: the correction and its one retry after a refusal of the contract. */
  const reviewCorrections = MAX_REVIEW_ROUNDS * 2;
  assert.equal(
    leadCorrectionBudget({ maxRetries }),
    MAX_STATIC_FIX_ROUNDS + MAX_PRE_EXEC_REGENERATIONS + maxRetries + MAX_COVERAGE_REGENERATIONS + reviewCorrections,
  );
});

test("a run that allows more fix-loop rounds has a larger budget", () => {
  assert.equal(leadCorrectionBudget({ maxRetries: 5 }) - leadCorrectionBudget({ maxRetries: 2 }), 3);
});

test("a correction goes through the lead while the budget has room", () => {
  assert.equal(leadCorrectionAction({ used: 0, budget: 8 }), "through-lead");
  assert.equal(leadCorrectionAction({ used: 7, budget: 8 }), "through-lead");
});

test("a correction goes to a direct regeneration once the budget is spent", () => {
  assert.equal(leadCorrectionAction({ used: 8, budget: 8 }), "direct");
  assert.equal(leadCorrectionAction({ used: 9, budget: 8 }), "direct");
});
