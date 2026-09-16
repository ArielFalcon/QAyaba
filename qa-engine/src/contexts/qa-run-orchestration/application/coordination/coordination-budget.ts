// Coordination must not silently duplicate CycleBudget / WallClockBudget. Hold the run VOs
// intact and pass them through to the existing generation boundary.
import type { CycleBudget } from "../../domain/cycle-budget.ts";
import type { WallClockBudget } from "../../domain/wall-clock-budget.ts";

export interface CoordinationBudget {
  readonly cycle: CycleBudget;
  readonly wallClock: WallClockBudget;
}
