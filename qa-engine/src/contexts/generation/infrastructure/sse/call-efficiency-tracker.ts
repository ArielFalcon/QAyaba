/*
 * Fine in-session call-efficiency tracker (design D1/D6/D7/D8/D12). Fed the raw
 * OpenCode SSE `message.part.updated` events by event-stream.ts, it sees the raw
 * tool name and raw input path (never `targetFor()`'s display string) and, when
 * a turn's prompt resolves, `take()` returns that turn's `TurnCallMetrics` — the
 * delta since the same session's previous flush.
 *
 * Measure-only and isolated: it tracks only sessions attached through
 * `registerRunSession`, never feeds any decision (the progress gate's
 * reexplore counter is deliberately NOT fed from here), and a fault while
 * recording poisons that ONE session (its metrics become null) instead of
 * throwing into the SSE loop or the prompt path.
 */
import { resolve } from "node:path";
import type { RawOpencodeEvent } from "./activity-mapper.ts";
import { bucketForTool, type CallBucket } from "../../domain/tool-call-taxonomy.ts";
import {
  detectRedundantReads,
  isContentReadTool,
  summarizeCallSequence,
  type CallRecord,
  type ReadWriteEvent,
} from "../../domain/call-sequence.ts";
import { indexPromptLines, isProvidedByPrompt, sampleReadOutput } from "../../domain/provided-context.ts";
import { buildTurnCallMetrics, type TurnCallMetrics } from "../../domain/turn-efficiency-summary.ts";

interface PartLike {
  id?: string;
  type?: string;
  sessionID?: string;
  callID?: string;
  tool?: string;
  state?: { status?: string; input?: unknown; output?: unknown };
}

interface TrackedCall {
  callId: string;
  tool: string;
  bucket: CallBucket;
  repeatKey: string;
  path?: string;
  /** Up to PROVIDED_CONTEXT_SAMPLE_LINES normalized lines of a completed content read. */
  sample?: string[];
}

interface SessionState {
  cwd: string;
  poisoned: boolean;
  /** Distinct callIds in the order they were first seen running or completed (D6). */
  order: string[];
  calls: Map<string, TrackedCall>;
  stepStarts: Set<string>;
  flushedCalls: number;
  flushedSteps: number;
  eventsSinceFlush: number;
}

const PATH_KEYS = ["filePath", "path", "file", "filename"] as const;

/** JSON with object keys sorted, so equal inputs stringify equally whatever their key order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function pathOf(input: unknown, cwd: string): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value) return resolve(cwd, value);
  }
  return undefined;
}

function newSession(cwd: string): SessionState {
  return {
    cwd,
    poisoned: false,
    order: [],
    calls: new Map(),
    stepStarts: new Set(),
    flushedCalls: 0,
    flushedSteps: 0,
    eventsSinceFlush: 0,
  };
}

function toCallRecord(call: TrackedCall): CallRecord {
  return { callId: call.callId, status: "completed", bucket: call.bucket, repeatKey: call.repeatKey };
}

function toReadWriteEvent(call: TrackedCall): ReadWriteEvent {
  return { callId: call.callId, status: "completed", bucket: call.bucket, tool: call.tool, ...(call.path ? { path: call.path } : {}) };
}

export class CallEfficiencyTracker {
  private readonly sessions = new Map<string, SessionState>();

  /** Starts tracking a session; events for any session not attached here are ignored. `cwd` resolves relative tool paths. */
  attach(sessionId: string, cwd: string): void {
    this.sessions.set(sessionId, newSession(cwd));
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Never throws: a fault poisons only the affected session. */
  record(event: RawOpencodeEvent): void {
    if (event.type !== "message.part.updated") return;
    const part = event.properties?.part as PartLike | undefined;
    const sessionId = part?.sessionID;
    if (!part || !sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session || session.poisoned) return;
    try {
      this.apply(session, part);
    } catch (err) {
      session.poisoned = true;
      console.error(
        `[qa] call-efficiency tracking failed for session ${sessionId}; its efficiency metrics are dropped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private apply(session: SessionState, part: PartLike): void {
    if (part.type === "step-start") {
      if (part.id) session.stepStarts.add(part.id);
      session.eventsSinceFlush++;
      return;
    }
    if (part.type !== "tool" || !part.callID || !part.tool) return;
    session.eventsSinceFlush++;

    const status = part.state?.status;
    if (status !== "running" && status !== "completed" && status !== "error") return;

    let call = session.calls.get(part.callID);
    if (!call) {
      /* D6: a call counts from its first running/completed sighting; an error with no prior
         running sighting never entered the sequence. */
      if (status === "error") return;
      call = { callId: part.callID, tool: part.tool, bucket: bucketForTool(part.tool), repeatKey: "" };
      session.calls.set(part.callID, call);
      session.order.push(part.callID);
    }

    const input = part.state?.input;
    call.repeatKey = `${part.tool}\u0000${stableStringify(input ?? null)}`;
    const path = pathOf(input, session.cwd);
    if (path) call.path = path;

    if (status === "completed" && isContentReadTool(part.tool) && typeof part.state?.output === "string") {
      call.sample = sampleReadOutput(part.state.output);
    }
  }

  /**
   * Metrics for the turn that just resolved (the delta since this session's previous flush), or
   * null when the session is unknown, poisoned, or saw no event during the turn.
   * `promptText` is the turn's prompt, used to spot reads of content it already contained.
   */
  take(sessionId: string, promptText: string): TurnCallMetrics | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.poisoned || session.eventsSinceFlush === 0) return null;

    const calls = session.order.map((id) => session.calls.get(id)!);
    const turnCalls = calls.slice(session.flushedCalls);

    const duplicatesNow = summarizeCallSequence(calls.map(toCallRecord)).repeatedCallCount;
    const duplicatesBefore = summarizeCallSequence(calls.slice(0, session.flushedCalls).map(toCallRecord)).repeatedCallCount;

    const redundant = detectRedundantReads(calls.map(toReadWriteEvent));
    const promptIndex = indexPromptLines(promptText);
    const newSteps = session.stepStarts.size - session.flushedSteps;

    const metrics = buildTurnCallMetrics({
      sequence: { ...summarizeCallSequence(turnCalls.map(toCallRecord)), repeatedCallCount: duplicatesNow - duplicatesBefore },
      buckets: turnCalls.map((call) => call.bucket),
      redundantReadCount: turnCalls.filter((call) => redundant.has(call.callId)).length,
      promptProvidedReadCount: turnCalls.filter((call) => call.sample && isProvidedByPrompt(call.sample, promptIndex)).length,
      stepsUsed: newSteps > 0 ? newSteps : null,
    });

    session.flushedCalls = calls.length;
    session.flushedSteps = session.stepStarts.size;
    session.eventsSinceFlush = 0;
    return metrics;
  }
}

export const callEfficiencyTracker = new CallEfficiencyTracker();
