import { test } from "node:test";
import assert from "node:assert/strict";
import { CycleBudget } from "@contexts/qa-run-orchestration/domain/cycle-budget.ts";

test("CycleBudget.derive: no override — ceiling comes from deriveCycleBackstop(maxRetries)", () => {
  const budget = CycleBudget.derive({ maxRetries: 2 });
  /* deriveCycleBackstop(2) = 24 (see derive-cycle-backstop.test.ts) */
  assert.equal(budget.ceiling, 24);
});

test("CycleBudget.derive: iterationBudget override wins unconditionally over the derived backstop", () => {
  const budget = CycleBudget.derive({ maxRetries: 2, iterationBudget: 5 });
  assert.equal(budget.ceiling, 5);
});

test("CycleBudget.derive: numObjectives threads through to deriveCycleBackstop", () => {
  const budget = CycleBudget.derive({ maxRetries: 2, numObjectives: 3 });
  /* deriveCycleBackstop(2, 3) = 24 + 8 = 32 (see derive-cycle-backstop.test.ts) */
  assert.equal(budget.ceiling, 32);
});
