/* Coordination must not duplicate CycleBudget / WallClockBudget. Hold the run VOs intact and pass them through to the generation boundary. */
import type { CycleBudget } from "../../../shared-kernel/cycle-budget.ts";
import type { WallClockBudget } from "../../../shared-kernel/wall-clock-budget.ts";

export interface CoordinationBudget {
  readonly cycle: CycleBudget;
  readonly wallClock: WallClockBudget;
}
