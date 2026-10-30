/*
 * The one place that decides whether the fix loop may start another regeneration turn on time grounds.
 * The run's deadline is the only clock: a regeneration needs time allotted to the fix purpose (what is left less what the
 * coverage, review and decision are owed), and when none is the turn is refused the way the agent runtime refuses it, so the
 * run ends on its time budget (E-TIME-BUDGET) instead of reporting a suite it had no time to repair.
 */
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import type { WorkspaceRunContext } from "./run-context.ts";

/* The role whose turn a fix-loop regeneration is. */
const REGENERATION_ROLE = "qa-author";

/* Throws the run's deadline error when no time is left for a regeneration; returns otherwise. */
export function assertRegenerationTime(ctx: WorkspaceRunContext): void {
  const deadline = ctx.services.runDeadlinePort;
  const allowance = deadline.allowance?.("fix") ?? null;
  if (allowance !== null && allowance <= 0) {
    const armed = deadline.describe?.();
    throw new RunDeadlineExceededError(armed?.budgetMs ?? 0, armed?.label ?? "unarmed", REGENERATION_ROLE, "before-turn");
  }
}
