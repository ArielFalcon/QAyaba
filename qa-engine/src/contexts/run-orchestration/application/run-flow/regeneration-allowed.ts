/*
 * The one place that decides whether the fix loop may start another regeneration turn on time grounds.
 * The run's deadline is the clock: a regeneration needs time left on it, and when none is left the turn is
 * refused the way the agent runtime refuses it, so the run ends on its time budget (E-TIME-BUDGET) instead of
 * reporting a suite it had no time to repair. Within the deadline, a regeneration also stays inside the run's
 * configured wall-clock budget, measured from the start of the run; a spent wall-clock budget ends the loop on
 * what it has. Both inputs stay configuration (the deadline's budget table, `wallClockBudgetMs` /
 * `agentTimeoutMs`); nothing else reads either.
 */
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import type { WorkspaceRunContext } from "./run-context.ts";
import { recordDegradation, recordLimit } from "./reducers.ts";
import type { RunState } from "./run-state.ts";

/* The role whose turn a fix-loop regeneration is. */
const REGENERATION_ROLE = "qa-author";

export function regenerationAllowed(ctx: WorkspaceRunContext, nowMs: number = Date.now()): boolean {
  const deadline = ctx.services.runDeadlinePort;
  const allowance = deadline.allowance?.("regeneration") ?? null;
  if (allowance !== null && allowance <= 0) {
    const armed = deadline.describe?.();
    throw new RunDeadlineExceededError(armed?.budgetMs ?? 0, armed?.label ?? "unarmed", REGENERATION_ROLE, "before-turn");
  }
  const budget = ctx.wallClockBudget;
  return !budget.exhausted(nowMs - ctx.startedAt);
}

/* What the fix loop's round says when the wall-clock budget refuses its regeneration. */
const WALL_CLOCK_NOTE = "wall-clock budget exhausted: no further regeneration";

/* The wall-clock budget refused a regeneration: the limit that fired and the loop going on with what it has are facts of the run, and the round's note is derived from them. */
export function refuseRegeneration(state: Readonly<RunState>): string {
  recordLimit(state, { fired: "wall-clock-budget", role: REGENERATION_ROLE });
  recordDegradation(state, { reason: "regeneration-skipped", note: WALL_CLOCK_NOTE });
  return WALL_CLOCK_NOTE;
}
