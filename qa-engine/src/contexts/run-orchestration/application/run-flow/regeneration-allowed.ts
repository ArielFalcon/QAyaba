/*
 * The one place that decides whether the fix loop may start another regeneration turn on time grounds.
 * The run's deadline is the only clock. A regeneration needs time allotted to the fix purpose (what is left less what the coverage,
 * review and decision are owed). When the run itself has none left the turn is refused the way the agent runtime refuses it, so the
 * run ends on its time budget (E-TIME-BUDGET). When only the fix purpose's share is spent the run still has the time held for the
 * phases after it, so the regeneration is skipped, the loop goes on with what it has (the verdict it already holds, a failing run
 * still opens its Issue), and the limit that fired is a fact of the run.
 */
import { RunDeadlineExceededError } from "@kernel/run-deadline.ts";
import type { WorkspaceRunContext } from "./run-context.ts";
import { recordLimit } from "./reducers.ts";
import type { RunState } from "./run-state.ts";

/* The role whose turn a fix-loop regeneration is. */
const REGENERATION_ROLE = "qa-author";

/* What the round says when the fix purpose's share refuses its regeneration. */
const SHARE_SPENT_NOTE = "the time allotted to the fix loop is spent: no further regeneration";

/** Whether the fix loop may regenerate now. Throws the run's deadline error when the run itself has no time left. */
export function regenerationAllowed(ctx: WorkspaceRunContext): boolean {
  const deadline = ctx.services.runDeadlinePort;
  const allowance = deadline.allowance?.("fix") ?? null;
  if (allowance === null || allowance > 0) return true;
  const remaining = deadline.remainingMs?.();
  if (remaining !== undefined && remaining <= 0) {
    const armed = deadline.describe?.();
    throw new RunDeadlineExceededError(armed?.budgetMs ?? 0, armed?.label ?? "unarmed", REGENERATION_ROLE, "before-turn", { purpose: "fix" });
  }
  return false;
}

/* The fix purpose's share refused a regeneration: the limit that fired is a fact of the run and the round's note is derived from it. */
export function refuseRegeneration(state: Readonly<RunState>): string {
  recordLimit(state, { fired: "allotment", role: REGENERATION_ROLE, purpose: "fix" });
  return SHARE_SPENT_NOTE;
}
