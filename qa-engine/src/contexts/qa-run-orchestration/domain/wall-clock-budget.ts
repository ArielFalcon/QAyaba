/*
 * Wall-clock ceiling on a run's total generation time — the run's ACTUAL enforcement mechanism,
 * checked directly by run-qa.use-case.ts (via exhausted()) before each regen round. CycleBudget's
 * ceiling/cycleCount are telemetry-only (see cycle-budget.ts); nothing enforces a cycle count.
 *
 * "Unbounded" — no agentTimeoutMs and no wallClockBudgetMs override configured — is modeled as
 * budgetMs = Infinity, not a separate flag: exhausted() already returns false for it with no
 * extra branching (elapsedMs > Infinity is always false), so a caller never needs its own
 * "is this armed at all" guard alongside exhausted().
 */

import type { CycleBudget } from "./cycle-budget.ts";

export interface WallClockBudgetInput {
  cycleBudget: CycleBudget;
  agentTimeoutMs: number;
  wallClockBudgetMs?: number;
}

export class WallClockBudget {
  private constructor(readonly budgetMs: number) {}

  static derive(input: WallClockBudgetInput): WallClockBudget {
    /* Neither an explicit override nor a positive per-agent timeout is configured — there is
       nothing to derive a ceiling FROM, so the run is unbounded rather than accidentally deriving
       a zero (which would read as "already exhausted" below). */
    if (input.wallClockBudgetMs === undefined && input.agentTimeoutMs <= 0) return WallClockBudget.unbounded();
    const budgetMs = input.wallClockBudgetMs ?? input.cycleBudget.ceiling * input.agentTimeoutMs;
    return new WallClockBudget(budgetMs);
  }

  static unbounded(): WallClockBudget {
    return new WallClockBudget(Infinity);
  }

  exhausted(elapsedMs: number): boolean {
    /* A non-positive, FINITE ceiling (an explicit wallClockBudgetMs override of 0 or less) means
       the budget is already spent. Infinity (unbounded) is excluded by this same comparison. */
    if (this.budgetMs <= 0) return true;
    return elapsedMs > this.budgetMs;
  }
}
