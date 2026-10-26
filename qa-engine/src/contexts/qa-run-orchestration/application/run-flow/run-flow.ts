/*
 * A run as a declarative table of steps. Each step has an id, reads the run's state, does its work and returns one closed outcome:
 * nothing or an update (go on to the next step), `goto` (go on to the step with that id), or `end` (the run is over, for a reason).
 * The runner walks the table in order: before each step it asks whether the run was cancelled and ends it `aborted` if so (a
 * cancelled run is never a failed login: an end in ABORT_SUPERSEDES under a cancelled run becomes `aborted` too), a step whose `runs` says no is passed over, a step that names a phase opens it on the run's
 * phase cursor first (a step without one runs inside the phase already open), an update is merged into the state, and the first
 * end stops the walk. Every step the runner passes over, runs or ends on is reported to the run's recorder, so the trace says in
 * which order the steps came and why the run stopped. The runner does not turn an end into a result: that is `finalizeRun`.
 */

import type { RunPhase } from "../../domain/run-phase-cursor.ts";
import type { EndReason } from "./end-reason.ts";
import { guarded, type DegradeReason, type StepClass } from "./failure-policy.ts";
import { runEnd, supersededByAbort, type FactsArg, type RunEnd } from "./run-end.ts";
import type { StepId } from "./step-ids.ts";

/** What a step decides: go on (nothing, or an update), go to a named step, or end the run. */
export type StepOutcome<S, Id extends string = StepId> = void | { update: Partial<S> } | { goto: Id; update?: Partial<S> } | { end: RunEnd; update?: Partial<S> };

/** Go on to the next step. */
export const next = <S, Id extends string = StepId>(update?: Partial<S>): StepOutcome<S, Id> => (update ? { update } : undefined);

/** Go on to the step with this id. */
export const goto = <S, Id extends string = StepId>(id: Id, update?: Partial<S>): StepOutcome<S, Id> => ({ goto: id, ...(update ? { update } : {}) });

/** End the run for a reason, carrying the facts that reason has. */
export const end = <S, R extends EndReason, Id extends string = StepId>(reason: R, ...facts: FactsArg<R>): StepOutcome<S, Id> => ({ end: runEnd(reason, ...facts) });

export interface FlowStep<S, C, Id extends string = StepId> {
  /** Stable identity of the step: what the trace, the tests and the failure policy call it. */
  id: Id;
  /** What the step is to the run (see failure-policy.ts); absent, it is `required`. */
  class?: StepClass;
  /** The phase the step opens on the cursor before it runs; absent, it runs inside the open phase. */
  phase?: RunPhase;
  /** Whether the step runs for this run; absent, it always does. */
  runs?: (state: Readonly<S>, ctx: C) => boolean;
  run: (state: Readonly<S>, ctx: C) => Promise<StepOutcome<S, Id>>;
}

/** What the runner tells the recorder about one step: it ran, it was passed over, or it ended the run (with the reason). */
export type StepEvent<Id extends string = StepId> =
  | { id: Id; outcome: "ran" | "skipped" }
  | { id: Id; outcome: "ended"; reason: RunEnd["reason"] };

/** What the runner needs from the run: the phase cursor, and somewhere to report the steps. */
export interface FlowHooks<Id extends string = StepId, S = object> {
  /** Whether the run was cancelled: asked before every step, and the run ends `aborted` as soon as it was. */
  aborted(): boolean;
  /** The end a failure that ends the run is turned into: the caller knows the run, the runner does not. */
  endOf(reason: EndReason, err: unknown): RunEnd;
  /** Where the run goes on from a step whose fault the policy degrades; absent, such a fault is rethrown. */
  degrade?(reason: DegradeReason, err: unknown, stepId: Id, state: Readonly<S>): StepOutcome<S, Id> | Promise<StepOutcome<S, Id>>;
  enter(phase: RunPhase): void;
  record(event: StepEvent<Id>): void;
}

/** The end the run came to, or the state once every step ran without ending it. */
export type FlowOutcome<S> = { end: RunEnd } | { state: S };

/* A table that sends the run back for ever is a defect of the table; the walk stops loudly instead of hanging. */
const MAX_TRANSITIONS = 10_000;

/** Throws on a table whose ids are not unique: a step must be told apart from every other. */
export function validateTable<S, C, Id extends string>(steps: ReadonlyArray<FlowStep<S, C, Id>>): void {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) throw new Error(`the step table names "${step.id}" twice`);
    seen.add(step.id);
  }
}

export async function runFlow<S extends object, C, Id extends string = StepId>(
  steps: ReadonlyArray<FlowStep<S, C, Id>>,
  state: S,
  ctx: C,
  hooks: FlowHooks<Id, NoInfer<S>>,
): Promise<FlowOutcome<S>> {
  validateTable(steps);
  let index = 0;
  for (let transitions = 0; index < steps.length; transitions++) {
    if (transitions >= MAX_TRANSITIONS) throw new Error(`the step table did not end after ${MAX_TRANSITIONS} transitions`);
    const step = steps[index]!;
    if (hooks.aborted()) {
      hooks.record({ id: step.id, outcome: "ended", reason: "aborted" });
      return { end: runEnd("aborted") };
    }
    if (step.runs && !step.runs(state, ctx)) {
      hooks.record({ id: step.id, outcome: "skipped" });
      index++;
      continue;
    }
    if (step.phase) hooks.enter(step.phase);
    const degrade = hooks.degrade;
    const outcome: StepOutcome<S, Id> = await guarded(
      { id: step.id, class: step.class ?? "required" },
      () => step.run(state, ctx),
      hooks.endOf,
      degrade ? (reason, err) => degrade.call(hooks, reason, err, step.id, state) : undefined,
    );
    if (outcome && "end" in outcome) {
      if (outcome.update) Object.assign(state, outcome.update);
      const ending = hooks.aborted() && supersededByAbort(outcome.end) ? runEnd("aborted") : outcome.end;
      hooks.record({ id: step.id, outcome: "ended", reason: ending.reason });
      return { end: ending };
    }
    hooks.record({ id: step.id, outcome: "ran" });
    if (outcome?.update) Object.assign(state, outcome.update);
    if (outcome && "goto" in outcome) {
      const target = steps.findIndex((candidate) => candidate.id === outcome.goto);
      if (target < 0) throw new Error(`the step "${step.id}" goes to "${outcome.goto}", which the step table does not have`);
      index = target;
    } else {
      index++;
    }
  }
  /* A cancel that came during the last step still ends the run, before whatever follows the table. */
  if (hooks.aborted()) return { end: runEnd("aborted") };
  return { state };
}
