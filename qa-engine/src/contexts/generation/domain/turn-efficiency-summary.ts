/*
 * Per-turn efficiency summary types and their assembly.
 * `CALL_BUCKETS` is re-exported here for convenience — its single
 * source of truth is `tool-call-taxonomy.ts`.
 */

import { CALL_BUCKETS, type CallBucket } from "./tool-call-taxonomy.ts";
import type { CallSequenceSummary } from "./call-sequence.ts";
import { stepExhaustionState, type StepExhaustionInput } from "./step-exhaustion.ts";
import type { ToolSequenceEntry } from "./tool-sequence.ts";
import type { TurnTrace } from "./turn-trace.ts";

export { CALL_BUCKETS };
export type { CallBucket };

export interface TurnStepBudget {
  maxSteps: number | null;
  /** True: the turn hit its step limit. False: known not to have. Null: unknown (no complete count and no notice) — never read as false. */
  exhausted: boolean | null;
}

/** What a turn spent over every step it finished (the sum of its step-finish parts), as opposed to the usage of the last assistant message alone. */
export interface TurnUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** How many finished steps the sums cover. */
  steps: number;
}

export interface TurnCallMetrics {
  totalCalls: number;
  /** Steps the turn opened; null unless every one of them was observed. */
  stepsUsed: number | null;
  /** Whether the turn's tool calls and steps were all observed. Held in memory for the turn's stats; not persisted. */
  observationComplete: boolean;
  callsBeforeFirstWrite: number;
  writeCount: number;
  /** Calls made through a shell tool, whatever their command line did: the quantity the coarse classifier counts as commands. Held in memory for the turn's stats; not persisted. */
  commandCount: number;
  redundantReadCount: number;
  /** Content reads of a file the turn's session had already read, whatever window either asked for, with no write to it in between: re-exploration, which `redundantReadCount` (the same window again) undercounts. */
  sameFileReadCount: number;
  duplicateCallCount: number;
  promptProvidedReadCount: number;
  /** Content reads of a file the prompt listed by path as already rendered (even compactly). Counted by path, apart from the content-based `promptProvidedReadCount`. */
  pathProvidedReadCount: number;
  /** Content reads whose lines a code-graph answer earlier in the session had already shown. Counted by content, apart from the prompt's two counts. */
  graphProvidedReadCount: number;
  buckets: Record<CallBucket, number>;
  /** Milliseconds from the turn's start to its first call; null when the turn made none or its start was not observed. */
  timeToFirstCallMs: number | null;
  /** Milliseconds from the turn's start to its first write; null when the turn wrote nothing or its start was not observed. */
  timeToFirstWriteMs: number | null;
  /** Calls the runtime refused under a permission rule, whether or not they ever ran. */
  deniedCallCount: number;
  /** The turn's calls in order, each with the sanitized, capped target it pointed at (see `tool-sequence.ts`). */
  toolSequence: ToolSequenceEntry[];
  /** Usage summed over the turn's finished steps; null unless every step was observed and at least one finished. A step still running when a turn timed out is not in the sum. */
  usage: TurnUsage | null;
  /** The turn step by step and call by call, for its trace. Held in memory for the turn; never persisted. Absent from a turn that was not observed. */
  trace?: TurnTrace;
  /** The text and reasoning the turn streamed, each part prefixed by its type and the whole bounded to its tail; raw, not yet redacted. Held in memory for the turn; never part of the persisted metrics. Absent when the turn streamed none. */
  streamedText?: string;
}

const ZERO_BUCKETS: Record<CallBucket, number> = {
  [CALL_BUCKETS.CODE_READ]: 0,
  [CALL_BUCKETS.CODE_GRAPH]: 0,
  [CALL_BUCKETS.BROWSER]: 0,
  [CALL_BUCKETS.WRITE]: 0,
  [CALL_BUCKETS.VALIDATE_RUN]: 0,
  [CALL_BUCKETS.SCRIPT_RUN]: 0,
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
  sameFileReadCount: number;
  promptProvidedReadCount: number;
  pathProvidedReadCount: number;
  graphProvidedReadCount: number;
  stepsUsed: number | null;
  observationComplete: boolean;
  timeToFirstCallMs: number | null;
  timeToFirstWriteMs: number | null;
  deniedCallCount: number;
  toolSequence: ToolSequenceEntry[];
  usage: TurnUsage | null;
  trace?: TurnTrace;
  streamedText?: string;
}

/** Assembles the pinned `TurnCallMetrics` shape from a `CallSequenceSummary`
 *  (call-sequence.ts) plus the fine-only signals that have no coarse
 *  equivalent (redundant reads, prompt-already-provided reads, steps used). */
export function buildTurnCallMetrics(input: BuildTurnCallMetricsInput): TurnCallMetrics {
  return {
    totalCalls: input.sequence.totalCalls,
    stepsUsed: input.stepsUsed,
    observationComplete: input.observationComplete,
    callsBeforeFirstWrite: input.sequence.callsBeforeFirstWrite,
    writeCount: input.sequence.writeCount,
    commandCount: input.sequence.commandCount,
    redundantReadCount: input.redundantReadCount,
    sameFileReadCount: input.sameFileReadCount,
    duplicateCallCount: input.sequence.repeatedCallCount,
    promptProvidedReadCount: input.promptProvidedReadCount,
    pathProvidedReadCount: input.pathProvidedReadCount,
    graphProvidedReadCount: input.graphProvidedReadCount,
    buckets: tallyBuckets(input.buckets),
    timeToFirstCallMs: input.timeToFirstCallMs,
    timeToFirstWriteMs: input.timeToFirstWriteMs,
    deniedCallCount: input.deniedCallCount,
    toolSequence: input.toolSequence,
    usage: input.usage,
    ...(input.trace ? { trace: input.trace } : {}),
    ...(input.streamedText !== undefined ? { streamedText: input.streamedText } : {}),
  };
}

/** Resolves a turn's step budget: `maxSteps` is passed through as given
 *  (null when the runtime reports none), `exhausted` is the tri-state `stepExhaustionState`
 *  reads from the final step's text and the observed step count. */
export function buildTurnStepBudget(input: StepExhaustionInput): TurnStepBudget {
  return { maxSteps: input.maxSteps, exhausted: stepExhaustionState(input) };
}
