/*
 * The one place that decides whether the fix loop may start another regeneration turn on time grounds.
 * The run's deadline is the clock: a regeneration needs time left on it, and it also stays inside the
 * run's configured wall-clock budget, measured from the start of the run. Both inputs stay
 * configuration (the deadline's budget table, `wallClockBudgetMs` / `agentTimeoutMs`); nothing else reads either.
 */
import type { WorkspaceRunContext } from "./run-context.ts";

export function regenerationAllowed(ctx: WorkspaceRunContext, nowMs: number = Date.now()): boolean {
  const allowance = ctx.services.runDeadlinePort.allowance?.("regeneration") ?? null;
  if (allowance !== null && allowance <= 0) return false;
  const budget = ctx.wallClockBudget;
  return !budget.exhausted(nowMs - ctx.startedAt);
}
