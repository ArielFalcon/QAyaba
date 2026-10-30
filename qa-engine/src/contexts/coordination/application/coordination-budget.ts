/* Coordination must not duplicate CycleBudget. Hold the run VO intact and pass it through to the generation boundary. Time is not held here: the run deadline is the one clock. */
import type { CycleBudget } from "../../../shared-kernel/cycle-budget.ts";

export interface CoordinationBudget {
  readonly cycle: CycleBudget;
}
