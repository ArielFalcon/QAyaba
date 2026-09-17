import { test } from "node:test";
import assert from "node:assert/strict";
import { WallClockBudget } from "@contexts/qa-run-orchestration/domain/wall-clock-budget.ts";
import { CycleBudget } from "@contexts/qa-run-orchestration/domain/cycle-budget.ts";

test("WallClockBudget.derive: no override — budget = cycleBudget.ceiling * agentTimeoutMs", () => {
  const cycleBudget = CycleBudget.derive({ maxRetries: 0 });
  const budget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 1000 });
  assert.equal(budget.budgetMs, 16000);
});

test("WallClockBudget.derive: wallClockBudgetMs override wins unconditionally over the derived value", () => {
  const cycleBudget = CycleBudget.derive({ maxRetries: 0 }); /* ceiling=16 → derived would be 16000 */
  const budget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 1000, wallClockBudgetMs: 5000 });
  assert.equal(budget.budgetMs, 5000);
});

test("WallClockBudget.exhausted: false while elapsedMs <= budgetMs", () => {
  const cycleBudget = CycleBudget.derive({ maxRetries: 0 });
  const budget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 1000 });
  assert.equal(budget.exhausted(16000), false);
  assert.equal(budget.exhausted(1000), false);
});

test("WallClockBudget.exhausted: true once elapsedMs exceeds budgetMs", () => {
  const cycleBudget = CycleBudget.derive({ maxRetries: 0 });
  const budget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 1000 });
  assert.equal(budget.exhausted(16001), true);
});

test("WallClockBudget.exhausted: non-positive ceiling is already spent", () => {
  const cycleBudget = CycleBudget.derive({ maxRetries: 0 });
  const budget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 1000, wallClockBudgetMs: 0 });
  assert.equal(budget.exhausted(0), true);
  assert.equal(budget.exhausted(1), true);
});

test("WallClockBudget.recomputeFrom: recomputes budgetMs against a RAISED CycleBudget when no override is set", () => {
  const cycleBudget = CycleBudget.derive({ maxRetries: 2 });
  const budget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 1000 });
  const raisedCycleBudget = cycleBudget.raiseTo(3);
  const recomputed = budget.recomputeFrom(raisedCycleBudget);
  assert.equal(recomputed.budgetMs, 32000);
});

test("WallClockBudget.recomputeFrom: an override budgetMs is NEVER recomputed, even after a CycleBudget raise", () => {
  const cycleBudget = CycleBudget.derive({ maxRetries: 2 });
  const budget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 1000, wallClockBudgetMs: 5000 });
  const raisedCycleBudget = cycleBudget.raiseTo(3);
  const recomputed = budget.recomputeFrom(raisedCycleBudget);
  assert.equal(recomputed.budgetMs, 5000);
});

test("WallClockBudget.extendBy: additively extends the budget by the given ms (fixCases continuation path)", () => {
  const cycleBudget = CycleBudget.derive({ maxRetries: 0 });
  const budget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 1000 });
  const extended = budget.extendBy(2000);
  assert.equal(extended.budgetMs, 18000);
});

test("WallClockBudget.extendBy: is a no-op when a wallClockBudgetMs override is set", () => {
  const cycleBudget = CycleBudget.derive({ maxRetries: 0 });
  const budget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 1000, wallClockBudgetMs: 5000 });
  const extended = budget.extendBy(2000);
  assert.equal(extended.budgetMs, 5000);
});
