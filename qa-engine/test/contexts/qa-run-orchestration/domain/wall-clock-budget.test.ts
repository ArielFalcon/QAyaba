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

test("WallClockBudget.exhausted: an EXPLICIT non-positive wallClockBudgetMs override is already spent", () => {
  const cycleBudget = CycleBudget.derive({ maxRetries: 0 });
  const budget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 1000, wallClockBudgetMs: 0 });
  assert.equal(budget.exhausted(0), true);
  assert.equal(budget.exhausted(1), true);
});

/*
 * The formerly-external `wallClockArmed` guard in run-qa.use-case.ts existed only to prevent THIS
 * exact scenario (agentTimeoutMs 0/absent, no override → derived budgetMs of 0) from reading as
 * "already exhausted" and aborting every retry on the first millisecond. WallClockBudget now
 * models it itself: derive() returns the unbounded() instance, never a spent one.
 */
test("WallClockBudget.derive: no agentTimeoutMs and no override → unbounded (never exhausted), not a spent zero-budget", () => {
  const cycleBudget = CycleBudget.derive({ maxRetries: 0 });
  const budget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 0 });
  assert.equal(budget.budgetMs, Infinity);
  assert.equal(budget.exhausted(0), false);
  assert.equal(budget.exhausted(Number.MAX_SAFE_INTEGER), false, "unbounded must stay unexhausted no matter how much time has elapsed");
});

test("WallClockBudget.unbounded: exhausted() is always false, at any elapsed time", () => {
  const budget = WallClockBudget.unbounded();
  assert.equal(budget.budgetMs, Infinity);
  assert.equal(budget.exhausted(0), false);
  assert.equal(budget.exhausted(1_000_000_000), false);
});

test("WallClockBudget.derive: an explicit wallClockBudgetMs override with agentTimeoutMs 0 still derives normally (not unbounded)", () => {
  const cycleBudget = CycleBudget.derive({ maxRetries: 0 });
  const budget = WallClockBudget.derive({ cycleBudget, agentTimeoutMs: 0, wallClockBudgetMs: 5000 });
  assert.equal(budget.budgetMs, 5000);
  assert.equal(budget.exhausted(5001), true, "an explicit override must still enforce, even though agentTimeoutMs alone would have been unbounded");
});
