/*
 * The only functions that write the fields of the run's state that more than one step touches. A field that a step replaces as a
 * whole stays in that step's update; these are the fields several steps feed, where an unnoticed second writer would change what the
 * run proves, delivers or publishes. A reducer either returns the section it changes (the step puts it in its update) or, for a
 * field that is read while the step that writes it is still running, changes that field of the state in place. The test
 * `state-writers.test.ts` names, per field, the modules that may import its reducer.
 */

import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import type { TurnLimit } from "@kernel/turn-limit.ts";
import type { CoordinationGateSignal } from "@kernel/coordination.ts";
import type { RunDegradationFact } from "@kernel/run-trace-facts.ts";
import { mergeDeliveredSpecs, type DeliveredPass, type DeliveryOrigin } from "../../domain/helpers/delivered-specs.ts";
import type { CoverageOutcome, ExecutionOutcome, RunFacts, RunState } from "./run-state.ts";

/* execution.run: the whole execution replaces the previous one. */
export const withRun = (execution: ExecutionOutcome, run: NonNullable<ExecutionOutcome["run"]>): ExecutionOutcome => ({ ...execution, run });

/* execution.retries: a round that regenerates the specs adds to the count; nothing ever resets it. */
export const addRetries = (execution: ExecutionOutcome, rounds: number): ExecutionOutcome => ({ ...execution, retries: execution.retries + rounds });

/* coverage.acceptanceCalls: the acceptances spent so far, which name the namespace of the next one. */
export const withAcceptanceCalls = (coverage: CoverageOutcome, acceptanceCalls: number): CoverageOutcome => ({ ...coverage, acceptanceCalls });

/* coverage.acceptedRegenAfterMeasure: an accepted regeneration rewrote specs after the last measurement, and a measurement made after that clears it. */
export const acceptedRegeneration = (coverage: CoverageOutcome): CoverageOutcome => ({ ...coverage, acceptedRegenAfterMeasure: true });
export const remeasured = (coverage: CoverageOutcome): CoverageOutcome => ({ ...coverage, acceptedRegenAfterMeasure: false });

/* generation.delivered: read across the steps of a pass and rolled back when the pass is refused, so it changes in place. */
export function mergeDelivered(state: Readonly<RunState>, produced: DeliveredPass, source: DeliveryOrigin): void {
  state.generation.delivered = mergeDeliveredSpecs(state.generation.delivered, produced, source);
}

/* With `files`, only those are rolled back (an acceptance that kept the others): each takes back the entry it had before, and one created since goes. */
export function rollbackDelivered(state: Readonly<RunState>, snapshot: readonly DeliveredSpec[], files?: readonly string[]): void {
  if (files === undefined) {
    state.generation.delivered = snapshot;
    return;
  }
  const back = new Set(files.map(normalizeSpecPath));
  state.generation.delivered = [...state.generation.delivered.filter((d) => !back.has(d.file)), ...snapshot.filter((d) => back.has(d.file))];
}

/* proof: the sha256 of the bytes that executed green, by spec path; a later green execution of the file replaces it. */
export function recordProof(state: Readonly<RunState>, file: string, sha256: string): void {
  state.proof[file] = sha256;
}

/* run: what the trace and the crash records read; each is set when its fact becomes known, wherever the run stands. */
export function recordRunFact<K extends keyof RunFacts>(state: Readonly<RunState>, key: K, value: RunFacts[K]): void {
  state.run[key] = value;
}

/* run.limits: a limit the engine met at run level. The same limit met again (a second turn the deadline refused) is the same fact. */
export function recordLimit(state: Readonly<RunState>, limit: { fired: TurnLimit; role: string }): void {
  if (state.run.limits.some((known) => known.fired === limit.fired && known.role === limit.role)) return;
  state.run.limits.push({ fired: limit.fired, role: limit.role, scope: "run" });
}

/* run.degradations: a fault the run went on past, with the sentence its note carries. The same fault recorded again is the same fact. */
export function recordDegradation(state: Readonly<RunState>, degradation: RunDegradationFact): void {
  if (state.run.degradations.some((known) => known.reason === degradation.reason && known.note === degradation.note)) return;
  state.run.degradations.push(degradation);
}

/* coordination: what the lead/sidekick mode came to, and the corrections it routed afterwards. */
export function recordCoordination(state: RunState, signal: CoordinationGateSignal): void {
  state.coordination = signal;
}
