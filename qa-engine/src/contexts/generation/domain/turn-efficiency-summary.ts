/*
 * Per-turn efficiency summary types and their assembly.
 * `CALL_BUCKETS` is re-exported here for convenience — its single
 * source of truth is `tool-call-taxonomy.ts`.
 */

import { CALL_BUCKETS, type CallBucket } from "./tool-call-taxonomy.ts";
import type { CallSequenceSummary } from "./call-sequence.ts";
import { stepExhaustionState, type StepExhaustionInput } from "./step-exhaustion.ts";

export { CALL_BUCKETS };
export type { CallBucket };

export interface TurnStepBudget {
  maxSteps: number | null;
  /** True: the turn hit its step limit. False: known not to have. Null: unknown (no complete count and no notice) — never read as false. */
  exhausted: boolean | null;
}

export interface TurnCallMetrics {
  totalCalls: number;
  stepsUsed: number | null;
  callsBeforeFirstWrite: number;
  writeCount: number;
  redundantReadCount: number;
  duplicateCallCount: number;
  promptProvidedReadCount: number;
  buckets: Record<CallBucket, number>;
}

const ZERO_BUCKETS: Record<CallBucket, number> = {
  [CALL_BUCKETS.CODE_READ]: 0,
  [CALL_BUCKETS.BROWSER]: 0,
  [CALL_BUCKETS.WRITE]: 0,
  [CALL_BUCKETS.VALIDATE_RUN]: 0,
  [CALL_BUCKETS.MEMORY]: 0,
  [CALL_BUCKETS.SUBAGENT]: 0,
  [CALL_BUCKETS.OTHER]: 0,
};

/** Tallies a flat list of per-call buckets into a Record that always has
 *  every CallBucket key present (zero-filled), never a sparse object. */
export function tallyBuckets(buckets: readonly CallBucket[]): Record<CallBucket, number> {
  const tally = { ...ZERO_BUCKETS };
  for (const bucket of buckets) tally[bucket]++;
  return tally;
}

export interface BuildTurnCallMetricsInput {
  sequence: CallSequenceSummary;
  buckets: readonly CallBucket[];
  redundantReadCount: number;
  promptProvidedReadCount: number;
  stepsUsed: number | null;
}

/** Assembles the pinned `TurnCallMetrics` shape from a `CallSequenceSummary`
 *  (call-sequence.ts) plus the fine-only signals that have no coarse
 *  equivalent (redundant reads, prompt-already-provided reads, steps used). */
export function buildTurnCallMetrics(input: BuildTurnCallMetricsInput): TurnCallMetrics {
  return {
    totalCalls: input.sequence.totalCalls,
    stepsUsed: input.stepsUsed,
    callsBeforeFirstWrite: input.sequence.callsBeforeFirstWrite,
    writeCount: input.sequence.writeCount,
    redundantReadCount: input.redundantReadCount,
    duplicateCallCount: input.sequence.repeatedCallCount,
    promptProvidedReadCount: input.promptProvidedReadCount,
    buckets: tallyBuckets(input.buckets),
  };
}

/** Resolves a turn's step budget: `maxSteps` is passed through as given
 *  (null for Codex), `exhausted` is the tri-state `stepExhaustionState`
 *  reads from the final step's text and the observed step count. */
export function buildTurnStepBudget(input: StepExhaustionInput): TurnStepBudget {
  return { maxSteps: input.maxSteps, exhausted: stepExhaustionState(input) };
}
