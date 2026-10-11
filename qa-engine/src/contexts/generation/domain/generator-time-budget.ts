/* How long the generator's first pass may run. Pure: the change's size and the run mode in, a bound in milliseconds out, or none. */
import type { RunMode } from "@kernel/run-mode.ts";
import { DIFF_TIER_NAMES, DIFF_TIME_BUDGET_MS, diffTier, type DiffStat, type DiffTier } from "./diff-stat.ts";

/** The wall time the first pass may take for each tier, in milliseconds; null = no bound beyond the host's own default. */
export type DiffTimeBudgets = Readonly<Record<DiffTier, number | null>>;

/** The variable that overrides each tier's time, in milliseconds. Declared per tier so a tier added to the table cannot be left without one. */
export const DIFF_TIME_BUDGET_ENV: Readonly<Record<DiffTier, string>> = {
  tiny: "QA_DIFF_TIME_BUDGET_MS_TINY",
  focused: "QA_DIFF_TIME_BUDGET_MS_FOCUSED",
  broad: "QA_DIFF_TIME_BUDGET_MS_BROAD",
};

/** The word that removes a tier's bound (the host's own deadline stands). */
const NO_BOUND = "none";

function budgetFromEnv(tier: DiffTier, raw: string | undefined): number | null {
  const name = DIFF_TIME_BUDGET_ENV[tier];
  const text = raw?.trim() ?? "";
  if (text === "") return DIFF_TIME_BUDGET_MS[tier];
  if (text.toLowerCase() === NO_BOUND) return null;
  const ms = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`${name} must be a positive whole number of milliseconds or '${NO_BOUND}', got ${JSON.stringify(raw)}`);
  }
  return ms;
}

/**
 * The tiers' time budgets with the operator's overrides applied: a tier with no variable (or a blank one)
 * keeps `DIFF_TIME_BUDGET_MS`, `none` removes its bound, and any other value must be a positive whole number
 * of milliseconds or this throws, naming the variable. Pure: the caller hands in the environment. Whatever
 * is resolved here is still clamped by the host's own deadline in `generatorTimeBudgetMs`.
 */
export function resolveDiffTimeBudgets(env: Readonly<Record<string, string | undefined>>): DiffTimeBudgets {
  const entries = DIFF_TIER_NAMES.map((tier) => [tier, budgetFromEnv(tier, env[DIFF_TIME_BUDGET_ENV[tier]])] as const);
  return Object.fromEntries(entries) as DiffTimeBudgets;
}

export interface GeneratorTimeBudgetInput {
  mode: RunMode;
  /** The change's real size, as the effort tier of the prompt reads it. */
  stat: DiffStat;
  /** The longest a single prompt may run on this host (its transport deadline). A tier's time at or above it could never fire before the host's own deadline, so the host's deadline stays the bound. Absent: the host states none, so the tier's time stands. */
  capMs?: number;
  /** The time each tier allows; absent: the defaults (`DIFF_TIME_BUDGET_MS`). */
  budgets?: DiffTimeBudgets;
}

/**
 * The wall time the generator's first pass may take, or undefined for the host's own default. Only
 * a diff run is bounded by its change: the other modes keep the default, whatever they touch. A
 * tier the table leaves unbounded stays so, whatever the cap, and a tier whose time the cap does
 * not exceed is not a bound either: a timeout there is the host's, never the tier's.
 */
export function generatorTimeBudgetMs(input: GeneratorTimeBudgetInput): number | undefined {
  if (input.mode !== "diff") return undefined;
  const allowed = (input.budgets ?? DIFF_TIME_BUDGET_MS)[diffTier(input.stat)];
  if (allowed === null) return undefined;
  return input.capMs !== undefined && allowed >= input.capMs ? undefined : allowed;
}
