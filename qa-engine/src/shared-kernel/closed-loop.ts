/* The run_spec closed loop as the layers around it share it: the limits one run grants its generator, and what the run records about its use. */

export interface ClosedLoopLimits {
  /* Calls to run_spec in one run. */
  maxCalls: number;
  /* The longest one call may run. */
  perCallMs: number;
  /* Mutating requests (POST, PUT, PATCH, DELETE) the executed specs may send to DEV in one run. */
  maxDevWrites: number;
}

export const DEFAULT_CLOSED_LOOP_LIMITS: ClosedLoopLimits = { maxCalls: 8, perCallMs: 120_000, maxDevWrites: 20 };

/* What a run records: how often the generator used the tool, what its specs did to DEV, and whether the loop ended closed (every delivered spec seen passing in its final bytes), which is what retires the regenerations that would repeat that work. */
export interface ClosedLoopGateSignal {
  calls: number;
  devWrites: number;
  closed: boolean;
}
