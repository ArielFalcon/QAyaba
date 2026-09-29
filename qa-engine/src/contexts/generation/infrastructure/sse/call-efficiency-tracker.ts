/*
 * Fine in-session call-efficiency tracker. Fed the raw
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
import { bucketForTool, toolInputPath, type CallBucket } from "../../domain/tool-call-taxonomy.ts";
import {
  detectRedundantReads,
  isContentReadTool,
  readWindowOf,
  summarizeCallSequence,
  type CallRecord,
  type ReadWriteEvent,
} from "../../domain/call-sequence.ts";
import { indexPromptLines, isProvidedByPrompt, sampleReadOutput } from "../../domain/provided-context.ts";
import { callFingerprint } from "./call-fingerprint.ts";
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
  window?: string;
  /** Up to PROVIDED_CONTEXT_SAMPLE_LINES normalized lines of a completed content read. */
  sample?: string[];
}

interface SessionState {
  cwd: string;
  poisoned: boolean;
  /** Distinct callIds in the order they were first seen running or completed. */
  order: string[];
  calls: Map<string, TrackedCall>;
  stepStarts: Set<string>;
  flushedCalls: number;
  flushedSteps: number;
  /** Whether a step or tool event arrived since the previous flush; a turn with none has no metrics. */
  sawEventSinceFlush: boolean;
}

function pathOf(input: unknown, cwd: string): string | undefined {
  const named = toolInputPath(input);
  return named === undefined ? undefined : resolve(cwd, named);
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
    sawEventSinceFlush: false,
  };
}

function toCallRecord(call: TrackedCall): CallRecord {
  return { callId: call.callId, status: "completed", bucket: call.bucket, repeatKey: call.repeatKey };
}

function toReadWriteEvent(call: TrackedCall): ReadWriteEvent {
  return { callId: call.callId, status: "completed", bucket: call.bucket, tool: call.tool, ...(call.path ? { path: call.path } : {}), ...(call.window ? { window: call.window } : {}) };
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
      session.sawEventSinceFlush = true;
      return;
    }
    if (part.type !== "tool" || !part.callID || !part.tool) return;
    session.sawEventSinceFlush = true;

    const status = part.state?.status;
    if (status !== "running" && status !== "completed" && status !== "error") return;

    let call = session.calls.get(part.callID);
    /* A call counts from its first running/completed sighting; an error with no prior
       running sighting never entered the sequence. */
    if (!call && status === "error") return;

    /* A call is identified by its latest sighting's input. */
    const input = part.state?.input;
    const seen = { repeatKey: callFingerprint(part.tool, input), path: pathOf(input, session.cwd), window: readWindowOf(input) };
    if (call) {
      Object.assign(call, seen);
    } else {
      call = { callId: part.callID, tool: part.tool, bucket: bucketForTool(part.tool), ...seen };
      session.calls.set(part.callID, call);
      session.order.push(part.callID);
    }

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
    if (!session || session.poisoned || !session.sawEventSinceFlush) return null;

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
    session.sawEventSinceFlush = false;
    return metrics;
  }
}

export const callEfficiencyTracker = new CallEfficiencyTracker();
