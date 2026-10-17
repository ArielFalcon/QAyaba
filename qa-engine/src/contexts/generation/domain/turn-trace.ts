/*
 * What the event stream showed of one agent turn, step by step and call by call, for the trace of that turn. Records only: the
 * tracker fills them in as events arrive, the span builder reads them when the turn ends. Held in memory for the turn and never
 * persisted. Times are wall-clock milliseconds: a call's are the runtime's own (`state.time`), a step's are the moments the
 * orchestrator received its start and finish (the runtime stamps neither).
 */
import type { CallBucket } from "./tool-call-taxonomy.ts";

/* The most steps and the most calls one turn's trace keeps; what comes after is counted in `truncated`, not kept. */
export const TRACE_MAX_ENTRIES = 500;

/* What one finished step spent, as the runtime reports it: `input` EXCLUDES the cache reads and writes (the mapping module normalizes it to the conventions' inclusive count). */
export interface StepUsageTrace {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface StepTrace {
  /* 1-based within the turn. */
  index: number;
  /* Receive times; null when the event that would have set them was not seen. */
  startedAt: number | null;
  finishedAt: number | null;
  /* The runtime's finish reason (stop, tool-calls, length, ...), as reported. */
  reason: string | null;
  usage: StepUsageTrace | null;
  /* Ids of the calls first seen while this step was open, in order. */
  callIds: string[];
}

export type CallStatus = "running" | "completed" | "error";

export interface CallTrace {
  callId: string;
  tool: string;
  bucket: CallBucket;
  status: CallStatus;
  /* The runtime's own times for the call (`state.time`); null when it reported none. */
  startedAt: number | null;
  endedAt: number | null;
  /* When the orchestrator first saw the call. */
  firstSeenAt: number;
  /* The step the call was first seen in; null when it was seen outside any step. */
  step: number | null;
  denied: boolean;
  targetKind: "path" | "pattern" | "url" | "command" | "query" | "element" | null;
  /* Redacted and capped. */
  target: string | null;
  /* The path inside the working copy, when the call named one that lies inside. */
  relPath?: string;
  /* A bounded prefix of a navigation's answer, kept only for the outcome classifier; never exported. */
  navOutput?: string;
}

export interface TurnTrace {
  /* When the turn was first prepared (its first attempt began); null when unknown. */
  startedAt: number | null;
  /* Receive time of the turn's first step start. */
  firstStepAt: number | null;
  steps: StepTrace[];
  calls: CallTrace[];
  /* More steps or calls than TRACE_MAX_ENTRIES happened. */
  truncated: boolean;
}
