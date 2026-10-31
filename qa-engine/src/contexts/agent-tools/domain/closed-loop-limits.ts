/* What an app's `qa.closedLoop` block decides about the run_spec calls a run grants its generator, over the kernel's defaults. Pure: the shell hands in the block as the app declared it. */
import { DEFAULT_CLOSED_LOOP_LIMITS, type ClosedLoopLimits } from "@kernel/closed-loop.ts";

/* The part of an app's `qa.closedLoop` that sets limits. */
export interface ClosedLoopDeclaration {
  maxCalls?: number | undefined;
  perCallMs?: number | undefined;
  maxDevWrites?: number | undefined;
}

export function closedLoopLimitsOf(declared: ClosedLoopDeclaration | undefined): ClosedLoopLimits {
  return {
    maxCalls: declared?.maxCalls ?? DEFAULT_CLOSED_LOOP_LIMITS.maxCalls,
    perCallMs: declared?.perCallMs ?? DEFAULT_CLOSED_LOOP_LIMITS.perCallMs,
    maxDevWrites: declared?.maxDevWrites ?? DEFAULT_CLOSED_LOOP_LIMITS.maxDevWrites,
    /* The app's maxCalls is a ceiling on its flows' calls together; absent, each flow is granted what its time can run. */
    ...(declared?.maxCalls !== undefined ? { callsCeiling: declared.maxCalls } : {}),
  };
}
