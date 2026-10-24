/*
 * A run as a declarative table of steps. Each step reads the run's state, does its work and either returns an update to the
 * state or ends the run with a result. The runner walks the table in order: a step whose `runs` says no is passed over, a step
 * that names a phase opens it on the run's phase cursor first (a step without one runs inside the phase already open), an
 * update is merged into the state, and the first end stops the walk. Loops (static fix, fix loop, review rounds) live inside
 * their step: the table itself is linear.
 */

import type { RunPhase } from "../../domain/run-phase-cursor.ts";

export type StepResult<S, R> = { end: R } | { update: Partial<S> } | void;

export interface FlowStep<S, C, R> {
  /** What the step does, for a reader of the table. */
  name: string;
  /** The phase the step opens on the cursor before it runs; absent, it runs inside the open phase. */
  phase?: RunPhase;
  /** Whether the step runs for this run; absent, it always does. */
  runs?: (state: Readonly<S>, ctx: C) => boolean;
  run: (state: Readonly<S>, ctx: C) => Promise<StepResult<S, R>>;
}

/** The result a step ended the run with, or the state once every step ran without ending it. */
export type FlowOutcome<S, R> = { end: R } | { state: S };

export async function runFlow<S extends object, C, R>(
  steps: ReadonlyArray<FlowStep<S, C, R>>,
  state: S,
  ctx: C,
  enter: (phase: RunPhase) => void,
): Promise<FlowOutcome<S, R>> {
  for (const step of steps) {
    if (step.runs && !step.runs(state, ctx)) continue;
    if (step.phase) enter(step.phase);
    const result = await step.run(state, ctx);
    if (!result) continue;
    if ("end" in result) return { end: result.end };
    Object.assign(state, result.update);
  }
  return { state };
}
