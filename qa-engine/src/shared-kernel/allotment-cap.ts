/*
 * A cap on a purpose's time (`planBudgetMs`, `flowBudgetMs`, `perCallMs`) is an upper bound of the allowance the run
 * deadline gives that purpose, never a clock of its own. Whoever states a time for a prompt, a flow or a tool call states the smaller of
 * the two and the limit that is the smaller one, so the time a turn is told is the time it gets and the end it comes to is typed by the
 * bound that ended it.
 */
import type { TimeLimitSource } from "./turn-limit.ts";

/* The caps a caller states for a purpose; `tier-budget` stays readable in the vocabulary but no caller can state it. */
export type CapLimit = Extract<TimeLimitSource, "plan-budget" | "flow-budget" | "tool-call">;

export interface HeldTime {
  ms: number;
  /** The bound that is `ms`: the cap, or the purpose's allotment when that comes no later (a tie is the allotment's, the stronger fact). The decorator names it `run-deadline` instead when the allotment is all that is left of the run. */
  limit: CapLimit | "allotment";
}

/** The time a purpose may spend under `cap` when the run's deadline allows it `allowanceMs` (null or undefined: no deadline is armed, the cap stands alone). */
export function heldTo(cap: { ms: number; limit: HeldTime["limit"] }, allowanceMs: number | null | undefined): HeldTime {
  if (allowanceMs === null || allowanceMs === undefined || cap.ms < allowanceMs) return { ms: cap.ms, limit: cap.limit };
  return { ms: Math.max(0, allowanceMs), limit: "allotment" };
}
