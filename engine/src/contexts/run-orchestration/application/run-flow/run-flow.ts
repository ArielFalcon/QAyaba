/*
 * A run as a declarative table of steps. Each step has an id, reads the run's state, does its work and returns one closed outcome:
 * nothing or an update (go on to the next step), `goto` (go on to the step with that id), or `end` (the run is over, for a reason).
 * The runner walks the table in order: before each step it asks whether the run was cancelled and ends it `aborted` if so (a
 * cancelled run is never a failed login: an end in ABORT_SUPERSEDES under a cancelled run becomes `aborted` too), a step whose `runs` says no is passed over, a step that names a phase opens it on the run's
 * phase cursor first (a step without one runs inside the phase already open), an update is merged into the state, and the first
 * end stops the walk. Every step the runner passes over, runs or ends on is reported to the run's recorder, so the trace says in
 * which order the steps came and why the run stopped. A step may declare the top-level fields of the state it updates (`writes`), and the runner refuses an update outside them. A fault a step lets escape goes through `guarded`, which asks the failure policy (failure-policy.ts) and gets one of: rethrow, end the run for a reason, or degrade (go on from a named step with the fault said on the outcome). Repair loops are not loops in a step: each round is a step of its own, and the step that decides the next one names it with `goto`, so the count of rounds lives in the state's `loops` and the way a loop ends is a pure function with one row per exit. The runner reports each step it passes over, runs or ends on to the recorder. The runner does not turn an end into a result: that is `finalizeRun`.
 */

import type { RunPhase } from "@kernel/run-step.ts";
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
  /** A step whose result the deadline cannot make untrue, so whatever it came to is its own, whenever the deadline fired: one that starts no process and spends no agent turn (the deadline has nothing of it to cut), or one that holds only what finished before the deadline (the mutation pass: a re-run the deadline killed is not judged and none starts after it). Absent, a step the deadline met is cut. */
  survivesDeadline?: boolean;
  /** The phase the step opens on the cursor before it runs; absent, it runs inside the open phase. */
  phase?: RunPhase;
  /** Whether the step runs for this run; absent, it always does. */
  runs?: (state: Readonly<S>, ctx: C) => boolean;
  /** Why the step was passed over, when `runs` said no: a step that is passed over by a decision of the run (a measurement with no green bytes to measure) says so in its event, so the trace never leaves a skipped step unexplained. Absent, the event carries no reason (the step's condition is the run's ordinary flow). */
  skipReason?: (state: Readonly<S>, ctx: C) => string;
  /** The top-level fields of the state the step updates; an update outside them is a defect of the step and the runner refuses it. */
  writes?: readonly (keyof S)[];
  run: (state: Readonly<S>, ctx: C) => Promise<StepOutcome<S, Id>>;
}

/** What the runner tells the recorder about one step: it ran, it was passed over (with its reason when the table gives one), or it ended the run (with the reason). */
export type StepEvent<Id extends string = StepId> =
  | { id: Id; outcome: "ran" }
  | { id: Id; outcome: "skipped"; reason?: string }
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
  /** Whether the run's deadline has been reached. A step during which it was reached is cut: whatever the step came to is the deadline's, not its own. Absent: nothing is cut. */
  deadlineFired?(): boolean;
  /** The error a step cut by the deadline ends with (a `RunDeadlineExceededError`); `cause` is what the step threw, if it threw; a cause that is already the deadline's own error is returned as it is. */
  deadlineCut?(stepId: Id, cause?: unknown): unknown;
}

/* The ends that are the run's decision or its own cancellation, which the deadline firing during the step does not take back. */
const FINAL_REASONS: ReadonlySet<string> = new Set(["decided", "context-pass", "aborted", "classify-skipped", "generation-noop", "run-deadline"]);

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

/* A step that declares what it writes does not update anything else: the declaration is how the state's writers are read off the table. */
function assertDeclared<S, C, Id extends string>(step: FlowStep<S, C, Id>, update: Partial<S> | undefined): void {
  if (!step.writes || !update) return;
  for (const key of Object.keys(update)) {
    if (!step.writes.includes(key as keyof S)) throw new Error(`the step "${step.id}" returned an update for "${key}", which it does not declare`);
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
    const wouldRun = !step.runs || step.runs(state, ctx);
    /* A step reached after the deadline fired meets it whether or not it would run, unless it survives the deadline: a deadline that fired during a step that outlived it is cut, and so recorded, at the first step it reaches, never left unrecorded because the steps after it had nothing to do. */
    const meetsDeadline = step.survivesDeadline !== true && hooks.deadlineFired?.() === true && hooks.deadlineCut !== undefined;
    if (!wouldRun && !meetsDeadline) {
      const reason = step.skipReason?.(state, ctx);
      hooks.record({ id: step.id, outcome: "skipped", ...(reason !== undefined ? { reason } : {}) });
      index++;
      continue;
    }
    if (wouldRun && step.phase) hooks.enter(step.phase);
    const degrade = hooks.degrade;
    /* A step the run's deadline met (it fired during the step, or before the step began) was cut by it, unless the step survives the deadline: its children were killed with it, so whatever it threw or came to says nothing but that. The policy then ends the run on its time budget, or keeps the proof the run already holds. */
    const cutDuring = (): boolean => step.survivesDeadline !== true && hooks.deadlineFired?.() === true && hooks.deadlineCut !== undefined;
    const outcome: StepOutcome<S, Id> = await guarded(
      { id: step.id, class: step.class ?? "required" },
      async () => {
        let result: StepOutcome<S, Id>;
        if (!wouldRun) throw hooks.deadlineCut!(step.id);
        try {
          result = await step.run(state, ctx);
        } catch (err) {
          if (cutDuring()) throw hooks.deadlineCut!(step.id, err);
          throw err;
        }
        if (cutDuring() && !(result && "end" in result && FINAL_REASONS.has(result.end.reason))) throw hooks.deadlineCut!(step.id);
        return result;
      },
      hooks.endOf,
      degrade ? (reason, err) => degrade.call(hooks, reason, err, step.id, state) : undefined,
    );
    if (outcome) assertDeclared(step, outcome.update);
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
