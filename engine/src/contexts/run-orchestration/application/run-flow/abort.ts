/*
 * Cancelling a run. The runner looks at the run's signal before every step (run-flow.ts) and ends the run `aborted`. A step that
 * runs long enough to start another agent turn or loop round on its own names the place it stops at with `throwIfAborted`, which the
 * runner turns into the same end.
 */

export class RunAbortedError extends Error {
  constructor() {
    super("the run was cancelled");
    this.name = "RunAbortedError";
  }
}

/** An interruption point inside a step: stops the step when the run was cancelled. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RunAbortedError();
}
