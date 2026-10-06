/*
 * Coarse (post-hoc) run-efficiency classifier — a pure function
 * over persisted `run_events`, applied identically to historical and new
 * runs. It windows `agent.activity` events on `step.changed`, so the
 * pre-generation grounding sub-step never inflates first-pass counts, and
 * reuses `summarizeCallSequence` (the same reducer the fine tracker uses)
 * so the metrics they share reconcile by construction.
 */

import type { RunEventBody } from "@kernel/contract/events.ts";
import { PRE_GENERATION_GROUNDING_STEP_DETAIL } from "@kernel/run-step.ts";
import { CALL_BUCKETS, type CallBucket } from "./tool-call-taxonomy.ts";
import { summarizeCallSequence, type CallRecord, type CallSequenceSummary } from "./call-sequence.ts";

export interface CoarseRunEfficiency {
  firstPass: CallSequenceSummary;
  grounding: CallSequenceSummary;
  wholeRunExcludingGrounding: CallSequenceSummary;
}

type AgentActivityEvent = Extract<RunEventBody, { type: "agent.activity" }>;

/* The coarse side only knows the 4-value agent.activity kind, never the raw tool —
   "analyzing" cannot be refined into code_read/browser/memory without it, so
   it maps to `other`. write/command/subagent map one-to-one, as in the fine taxonomy. */
function bucketForActivityKind(kind: AgentActivityEvent["kind"]): CallBucket {
  switch (kind) {
    case "writing": return CALL_BUCKETS.WRITE;
    case "command": return CALL_BUCKETS.VALIDATE_RUN;
    case "subagent": return CALL_BUCKETS.SUBAGENT;
    default: return CALL_BUCKETS.OTHER;
  }
}

/* The coarse side only counts agent.activity events that carry a callId;
   the (kind, target) pair is the best identity proxy available (no raw
   tool/input survives persistence) — this is why repeatedCallCount is a
   PROXY here, never required to reconcile exactly with the fine tracker. */
function toCallRecord(event: AgentActivityEvent): CallRecord {
  return {
    callId: event.callId!,
    status: event.status,
    bucket: bucketForActivityKind(event.kind),
    repeatKey: `${event.kind}:${event.target}`,
  };
}

const EMPTY_WINDOW = summarizeCallSequence([]);

type WindowPhase = "before-generate" | "grounding" | "first-pass" | "other";

export function classifyRunEfficiency(events: readonly RunEventBody[]): CoarseRunEfficiency {
  let phase: WindowPhase = "before-generate";
  let firstPassLocked = false;

  const grounding: AgentActivityEvent[] = [];
  const firstPass: AgentActivityEvent[] = [];
  const excludingGrounding: AgentActivityEvent[] = [];

  for (const event of events) {
    if (event.type === "step.changed") {
      if (event.step === "generate" && event.detail === PRE_GENERATION_GROUNDING_STEP_DETAIL) {
        phase = "grounding";
      } else if (event.step === "generate" && !firstPassLocked) {
        phase = "first-pass";
        firstPassLocked = true;
      } else {
        phase = "other";
      }
      continue;
    }

    if (event.type !== "agent.activity" || !event.callId) continue;

    if (phase === "grounding") {
      grounding.push(event);
      continue;
    }
    excludingGrounding.push(event);
    if (phase === "first-pass") firstPass.push(event);
  }

  return {
    firstPass: firstPass.length ? summarizeCallSequence(firstPass.map(toCallRecord)) : EMPTY_WINDOW,
    grounding: grounding.length ? summarizeCallSequence(grounding.map(toCallRecord)) : EMPTY_WINDOW,
    wholeRunExcludingGrounding: excludingGrounding.length
      ? summarizeCallSequence(excludingGrounding.map(toCallRecord))
      : EMPTY_WINDOW,
  };
}
