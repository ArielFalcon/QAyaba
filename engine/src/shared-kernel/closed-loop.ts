/* The run_spec closed loop as the layers around it share it: the limits one run grants its generator, and what the run records about its use. */

export interface ClosedLoopLimits {
  /* Calls to run_spec of the run's own loop. A plan's flows are each granted the calls their time can run, so their total is derived. */
  maxCalls: number;
  /* The app's ceiling on the run_spec calls of a plan's flows together (qa.closedLoop.maxCalls), which they then share; absent: none. */
  callsCeiling?: number;
  /* The longest one call may run. */
  perCallMs: number;
  /* Mutating requests (POST, PUT, PATCH, DELETE) the executed specs may send to DEV in one run: a cap that protects DEV's data, never derived from a plan; a flow's writes are a share of it. */
  maxDevWrites: number;
}

export const DEFAULT_CLOSED_LOOP_LIMITS: ClosedLoopLimits = { maxCalls: 8, perCallMs: 120_000, maxDevWrites: 20 };

/* What a run records: how often the generator used the tool, what its specs did to DEV, and whether the loop ended closed (every delivered spec seen passing in its final bytes), which is what retires the regenerations that would repeat that work. */
export interface ClosedLoopGateSignal {
  calls: number;
  devWrites: number;
  /* The run_spec calls the run's flows were granted, together: the run's derived total. Absent when no flow opened a loop. */
  granted?: number;
  /* Calls refused for writes to DEV: the run's cap was spent, or the calling flow's own share was. Absent when none was. */
  writesRefused?: number;
  closed: boolean;
}
