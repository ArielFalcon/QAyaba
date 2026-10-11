/* How long the generator's first pass may run. Pure: the change's size and the run mode in, a bound in milliseconds out, or none. */
import type { RunMode } from "@kernel/run-mode.ts";
import { DIFF_TIME_BUDGET_MS, diffTier, type DiffStat } from "./diff-stat.ts";

export interface GeneratorTimeBudgetInput {
  mode: RunMode;
  /** The change's real size, as the effort tier of the prompt reads it. */
  stat: DiffStat;
  /** The longest a single prompt may run on this host (its transport deadline): a bound above it could never fire. Absent: the host states none, so none is applied. */
  capMs?: number;
}

/**
 * The wall time one generator turn may take, or undefined for the host's own default. Only a diff
 * run is bounded by its change: the other modes keep the default, whatever they touch. A tier the
 * table leaves unbounded stays so, whatever the cap, because the cap is a ceiling and never a bound.
 */
export function generatorTimeBudgetMs(input: GeneratorTimeBudgetInput): number | undefined {
  if (input.mode !== "diff") return undefined;
  const allowed = DIFF_TIME_BUDGET_MS[diffTier(input.stat)];
  if (allowed === null) return undefined;
  return input.capMs === undefined ? allowed : Math.min(allowed, input.capMs);
}
