/*
 * Fine in-session call-efficiency tracker. Fed the raw
 * OpenCode SSE `message.part.updated` events by event-stream.ts, it sees the raw
 * tool name and raw input path (never `targetFor()`'s display string) and, when
 * a turn's prompt resolves, `take()` returns that turn's `TurnCallMetrics` — the
 * delta since the same session's previous flush.
 *
 * Isolated: it tracks only sessions attached through `registerRunSession`, never feeds the
 * progress gate (whose reexplore counter is deliberately NOT fed from here), and a fault while
 * recording poisons that ONE session (its metrics become null) instead of throwing into the SSE
 * loop or the prompt path.
 *
 * `stepsUsed` feeds the exhaustion decision: an incomplete observation yields `null`, never an
 * undercount. A turn's steps are complete only when the event stream for its directory was live
 * for the whole attempt. Each stream reports its lifecycle with a token (the directory's current
 * stream is the last one opened; events from any other token are ignored): opening, connected
 * (the first `server.connected`), interrupted (the SDK's own error callback, before it silently
 * reconnects) and closed. Anything that can lose events is a gap for every session attached to
 * that directory: an interruption, a second `server.connected` on a live stream, a close, a
 * stream replaced before it closed. `prepareAttempt` opens each attempt: it waits, bounded, for
 * a stream that is still opening, and only a fresh first attempt on a live stream is complete.
 * A half-open connection that has not errored by the time `take()` runs can still undercount;
 * the exhaustion notice in the final step remains the veto for that case.
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

/** How long an attempt waits for its directory's stream to connect before it is observed incompletely. */
export const OBSERVATION_READY_TIMEOUT_MS = 5_000;

/** Identifies one stream connection attempt of a directory; only the directory's latest token is heard. */
export type StreamToken = symbol;

export interface TrackerTimer {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimer: TrackerTimer = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
};

/** What the event loop tells the tracker about the stream it runs, so a session's step count knows when events may have been lost. */
export interface StreamLifecycleSink {
  streamOpening(directory: string, token: StreamToken): void;
  streamConnected(directory: string, token: StreamToken): void;
  streamInterrupted(directory: string, token: StreamToken): void;
  streamClosed(directory: string, token: StreamToken): void;
}

interface DirectoryStream {
  token: StreamToken;
  state: "opening" | "live" | "interrupted";
  /** Attempts waiting for the stream to connect; each is told whether it did. */
  waiters: Set<(live: boolean) => void>;
}

interface SessionState {
  cwd: string;
  /** Whether every step of the attempt in flight was observed. */
  stepsComplete: boolean;
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

function newSession(cwd: string, stepsComplete: boolean): SessionState {
  return {
    cwd,
    stepsComplete,
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

export class CallEfficiencyTracker implements StreamLifecycleSink {
  private readonly sessions = new Map<string, SessionState>();
  private readonly streams = new Map<string, DirectoryStream>();
  private readonly timer: TrackerTimer;

  constructor(options: { timer?: TrackerTimer } = {}) {
    this.timer = options.timer ?? realTimer;
  }

  /** Starts tracking a session; events for any session not attached here are ignored. `cwd` resolves relative tool paths. The session inherits the liveness of its directory's stream. */
  attach(sessionId: string, cwd: string): void {
    this.sessions.set(sessionId, newSession(cwd, this.streams.get(cwd)?.state === "live"));
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** A stream that opens replaces any earlier one of the directory (which may not have closed yet), so attempts already in flight lose their footing. */
  streamOpening(directory: string, token: StreamToken): void {
    this.markGap(directory);
    this.streams.set(directory, { token, state: "opening", waiters: this.streams.get(directory)?.waiters ?? new Set() });
  }

  streamConnected(directory: string, token: StreamToken): void {
    const stream = this.currentStream(directory, token);
    if (!stream) return;
    if (stream.state === "live") {
      this.markGap(directory);
      return;
    }
    stream.state = "live";
    this.releaseWaiters(stream, true);
  }

  streamInterrupted(directory: string, token: StreamToken): void {
    const stream = this.currentStream(directory, token);
    if (!stream) return;
    stream.state = "interrupted";
    this.markGap(directory);
  }

  streamClosed(directory: string, token: StreamToken): void {
    const stream = this.currentStream(directory, token);
    if (!stream) return;
    this.streams.delete(directory);
    this.markGap(directory);
    this.releaseWaiters(stream, false);
  }

  /**
   * Opens an attempt of a prompt on the session. The attempt is incomplete unless it is the first
   * one (a fallback attempt re-runs the prompt, so its steps and the first attempt's cannot be
   * told apart) and its directory's stream is live — waiting, bounded, for one still opening.
   * Steps of an earlier, abandoned attempt never reach this prompt's count. A session that was
   * never attached has nothing to observe.
   */
  async prepareAttempt(sessionId: string, attempt: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.stepsComplete = false;
    if (attempt > 0) return;
    session.flushedSteps = session.stepStarts.size;
    const stream = this.streams.get(session.cwd);
    if (stream?.state === "live") session.stepsComplete = true;
    else if (stream?.state === "opening") await this.waitForLive(stream, (live) => { session.stepsComplete = live; });
  }

  private currentStream(directory: string, token: StreamToken): DirectoryStream | undefined {
    const stream = this.streams.get(directory);
    return stream?.token === token ? stream : undefined;
  }

  /** Events may have been lost: every attempt in flight on this directory is incomplete. */
  private markGap(directory: string): void {
    for (const session of this.sessions.values()) {
      if (session.cwd === directory) session.stepsComplete = false;
    }
  }

  private releaseWaiters(stream: DirectoryStream, live: boolean): void {
    for (const settle of [...stream.waiters]) settle(live);
  }

  /** Resolves once the stream connects, closes or the readiness bound passes; `onSettled` runs at that very moment, before anything else can happen to the stream. */
  private waitForLive(stream: DirectoryStream, onSettled: (live: boolean) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      const settle = (live: boolean): void => {
        this.timer.clearTimeout(handle);
        stream.waiters.delete(settle);
        onSettled(live);
        resolve();
      };
      const handle = this.timer.setTimeout(() => settle(false), OBSERVATION_READY_TIMEOUT_MS);
      stream.waiters.add(settle);
    });
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
   * `promptText` is the turn's prompt, used to spot reads of content it already contained;
   * `providedPaths` are the files the prompt lists as rendered (even compactly), resolved against the
   * session's directory: a content read of one is path-provided, counted apart from the content match.
   */
  take(sessionId: string, promptText: string, providedPaths?: readonly string[]): TurnCallMetrics | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.poisoned || !session.sawEventSinceFlush) return null;

    const calls = session.order.map((id) => session.calls.get(id)!);
    const turnCalls = calls.slice(session.flushedCalls);

    const duplicatesNow = summarizeCallSequence(calls.map(toCallRecord)).repeatedCallCount;
    const duplicatesBefore = summarizeCallSequence(calls.slice(0, session.flushedCalls).map(toCallRecord)).repeatedCallCount;

    const redundant = detectRedundantReads(calls.map(toReadWriteEvent));
    const promptIndex = indexPromptLines(promptText);
    const provided = new Set(providedPaths?.map((p) => resolve(session.cwd, p)));
    const newSteps = session.stepStarts.size - session.flushedSteps;

    const metrics = buildTurnCallMetrics({
      sequence: { ...summarizeCallSequence(turnCalls.map(toCallRecord)), repeatedCallCount: duplicatesNow - duplicatesBefore },
      buckets: turnCalls.map((call) => call.bucket),
      redundantReadCount: turnCalls.filter((call) => redundant.has(call.callId)).length,
      promptProvidedReadCount: turnCalls.filter((call) => call.sample && isProvidedByPrompt(call.sample, promptIndex)).length,
      pathProvidedReadCount: turnCalls.filter((call) => isContentReadTool(call.tool) && call.path !== undefined && provided.has(call.path)).length,
      stepsUsed: session.stepsComplete && newSteps > 0 ? newSteps : null,
      observationComplete: session.stepsComplete,
    });

    session.flushedCalls = calls.length;
    session.flushedSteps = session.stepStarts.size;
    session.sawEventSinceFlush = false;
    return metrics;
  }
}

export const callEfficiencyTracker = new CallEfficiencyTracker();
