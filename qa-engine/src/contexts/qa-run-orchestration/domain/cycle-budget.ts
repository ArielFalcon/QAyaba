/* Regeneration-loop ceiling (MAX_CYCLES) and running cycleCount. Immutable: tick()/raiseTo() return a new instance.
iterationBudget config override wins over the derived backstop. raiseTo() refines the ceiling from planner objectives only when no override is set and the refined value is strictly greater — a backstop never truncates work already budgeted. */

import { deriveCycleBackstop } from "./helpers/derive-cycle-backstop.ts";

export interface CycleBudgetInput {
  maxRetries: number;
  iterationBudget?: number;
  numObjectives?: number;
}

export class CycleBudget {
  private constructor(
    readonly ceiling: number,
    readonly cycleCount: number,
    private readonly maxRetries: number,
    private readonly iterationBudgetOverride: number | undefined,
  ) {}

  static derive(input: CycleBudgetInput): CycleBudget {
    const ceiling = input.iterationBudget ?? deriveCycleBackstop(input.maxRetries, input.numObjectives);
    return new CycleBudget(ceiling, 0, input.maxRetries, input.iterationBudget);
  }

  tick(): CycleBudget {
    return new CycleBudget(this.ceiling, this.cycleCount + 1, this.maxRetries, this.iterationBudgetOverride);
  }

  exhausted(): boolean {
    return this.cycleCount > this.ceiling;
  }

  /* Scope-dimensioned bump. No-op when an iterationBudget override is set, or when the refined value would not exceed the current ceiling — raiseTo never shrinks the budget. */
  raiseTo(numObjectives: number): CycleBudget {
    if (this.iterationBudgetOverride !== undefined) return this;
    const refined = deriveCycleBackstop(this.maxRetries, numObjectives);
    if (refined <= this.ceiling) return this;
    return new CycleBudget(refined, this.cycleCount, this.maxRetries, this.iterationBudgetOverride);
  }
}
