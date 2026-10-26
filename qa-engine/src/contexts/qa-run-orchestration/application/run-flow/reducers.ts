/*
 * The only functions that write the fields of the run's state that more than one step touches. A field that a step replaces as a
 * whole stays in that step's update; these are the fields several steps feed, where an unnoticed second writer would change what the
 * run proves, delivers or publishes. A reducer either returns the section it changes (the step puts it in its update) or, for a
 * field that is read while the step that writes it is still running, changes that field of the state in place. The test
 * `state-writers.test.ts` names, per field, the modules that may import its reducer.
 */

import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import type { CoordinationGateSignal } from "@kernel/coordination.ts";
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

export function rollbackDelivered(state: Readonly<RunState>, snapshot: readonly DeliveredSpec[]): void {
  state.generation.delivered = snapshot;
}

/* proof: the sha256 of the bytes that executed green, by spec path; a later green execution of the file replaces it. */
export function recordProof(state: Readonly<RunState>, file: string, sha256: string): void {
  state.proof[file] = sha256;
}

/* run: what the trace and the crash records read; each is set when its fact becomes known, wherever the run stands. */
export function recordRunFact<K extends keyof RunFacts>(state: Readonly<RunState>, key: K, value: RunFacts[K]): void {
  state.run[key] = value;
}

/* coordination: what the lead/sidekick mode came to, and the corrections it routed afterwards. */
export function recordCoordination(state: RunState, signal: CoordinationGateSignal): void {
  state.coordination = signal;
}
