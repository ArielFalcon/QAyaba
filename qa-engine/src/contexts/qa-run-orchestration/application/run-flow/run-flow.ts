/*
 * A run as a declarative table of steps. Each step has an id, reads the run's state, does its work and either returns an update to
 * the state or ends the run with a reason. The runner walks the table in order: a step whose `runs` says no is passed over, a step
 * that names a phase opens it on the run's phase cursor first (a step without one runs inside the phase already open), an update is
 * merged into the state, and the first end stops the walk. Every step the runner passes over, runs or ends on is reported to the
 * run's recorder, so the trace says in which order the steps came and why the run stopped. Loops (static fix, fix loop, review
 * rounds) live inside their step: the table itself is linear.
 */

import type { RunPhase } from "../../domain/run-phase-cursor.ts";
import type { EndReason } from "./run-end.ts";
import type { StepId } from "./step-ids.ts";

export type StepResult<S, R> = { end: R; reason: EndReason } | { update: Partial<S> } | void;

export interface FlowStep<S, C, R, Id extends string = StepId> {
  /** Stable identity of the step: what the trace, the tests and the failure policy call it. */
  id: Id;
  /** The phase the step opens on the cursor before it runs; absent, it runs inside the open phase. */
  phase?: RunPhase;
  /** Whether the step runs for this run; absent, it always does. */
  runs?: (state: Readonly<S>, ctx: C) => boolean;
  run: (state: Readonly<S>, ctx: C) => Promise<StepResult<S, R>>;
}

/** What the runner tells the recorder about one step: it ran, it was passed over, or it ended the run (with the reason). */
export type StepEvent<Id extends string = StepId> =
  | { id: Id; outcome: "ran" | "skipped" }
  | { id: Id; outcome: "ended"; reason: EndReason };

/** What the runner needs from the run: the phase cursor, and somewhere to report the steps. */
export interface FlowHooks<Id extends string = StepId> {
  enter(phase: RunPhase): void;
  record(event: StepEvent<Id>): void;
}

/** The result a step ended the run with and why, or the state once every step ran without ending it. */
export type FlowOutcome<S, R> = { end: R; reason: EndReason } | { state: S };

export async function runFlow<S extends object, C, R, Id extends string = StepId>(
  steps: ReadonlyArray<FlowStep<S, C, R, Id>>,
  state: S,
  ctx: C,
  hooks: FlowHooks<Id>,
): Promise<FlowOutcome<S, R>> {
  for (const step of steps) {
    if (step.runs && !step.runs(state, ctx)) {
      hooks.record({ id: step.id, outcome: "skipped" });
      continue;
    }
    if (step.phase) hooks.enter(step.phase);
    const result = await step.run(state, ctx);
    if (result && "end" in result) {
      hooks.record({ id: step.id, outcome: "ended", reason: result.reason });
      return { end: result.end, reason: result.reason };
    }
    hooks.record({ id: step.id, outcome: "ran" });
    if (result) Object.assign(state, result.update);
  }
  return { state };
}
