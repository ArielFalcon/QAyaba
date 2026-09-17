/* Wall-clock ceiling on a run's total generation time. Immutable: recomputeFrom()/extendBy() return a new instance.
An explicit wallClockBudgetMs override wins unconditionally — once set it is never recomputed from a CycleBudget.raiseTo() bump or the fixCases continuation. agentTimeoutMs is a plain number so this VO stays free of mode / agent-runtime. */

import type { CycleBudget } from "./cycle-budget.ts";

export interface WallClockBudgetInput {
  cycleBudget: CycleBudget;
  agentTimeoutMs: number;
  wallClockBudgetMs?: number;
}

export class WallClockBudget {
  private constructor(
    readonly budgetMs: number,
    private readonly agentTimeoutMs: number,
    private readonly override: number | undefined,
  ) {}

  static derive(input: WallClockBudgetInput): WallClockBudget {
    const budgetMs = input.wallClockBudgetMs ?? input.cycleBudget.ceiling * input.agentTimeoutMs;
    return new WallClockBudget(budgetMs, input.agentTimeoutMs, input.wallClockBudgetMs);
  }

  exhausted(elapsedMs: number): boolean {
    /* A non-positive ceiling means the budget is already spent (no generation time left). */
    if (this.budgetMs <= 0) return true;
    return elapsedMs > this.budgetMs;
  }

  /* Recompute against a raised CycleBudget ceiling only when no override is set. */
  recomputeFrom(cycleBudget: CycleBudget): WallClockBudget {
    if (this.override !== undefined) return this;
    return new WallClockBudget(cycleBudget.ceiling * this.agentTimeoutMs, this.agentTimeoutMs, this.override);
  }

  /* fixCases continuation additive extension. No-op when an override is set (override wins unconditionally). */
  extendBy(extraMs: number): WallClockBudget {
    if (this.override !== undefined) return this;
    return new WallClockBudget(this.budgetMs + extraMs, this.agentTimeoutMs, this.override);
  }
}
