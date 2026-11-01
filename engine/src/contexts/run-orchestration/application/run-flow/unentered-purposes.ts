/*
 * The purposes a run's own state settles it will not enter, told to the deadline so no time is held back for a phase the run cannot
 * reach: the share of a later purpose is taken from the one the run is in, so a purpose the run will not enter must be owed none.
 */
import type { DeadlinePurpose } from "@kernel/deadline-purpose.ts";
import { hasGreenBytes, type RunVerdict } from "@kernel/run-verdict.ts";
import type { WorkspaceRunContext } from "./run-context.ts";

/*
 * The coverage purpose spends the app's measured time only where a measurement of this commit can be read: a context run executes
 * nothing, a cross-repo run measures no per-commit change, and a verdict with no green bytes has nothing to measure.
 */
export const purposesNotEntered = (verdict: RunVerdict, ctx: Pick<WorkspaceRunContext, "input">): readonly DeadlinePurpose[] =>
  hasGreenBytes(verdict) && ctx.input.mode !== "context" && ctx.input.triggerRepo === undefined ? [] : ["coverage"];

/* Said the moment the run's verdict settles what it can still reach; told again, the deadline keeps the last things the run said. */
export function tellPurposesNotEntered(verdict: RunVerdict, ctx: Pick<WorkspaceRunContext, "input" | "services">): void {
  ctx.services.runDeadlinePort.willNotEnter?.(purposesNotEntered(verdict, ctx));
}
