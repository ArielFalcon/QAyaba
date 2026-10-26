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
import { engineLog } from "@kernel/ports/process-logger.ts";
import { isAbsolute, relative, resolve } from "node:path";
import type { RawOpencodeEvent } from "./activity-mapper.ts";
import { CALL_BUCKETS, bucketForTool, isCodeGraphTool, isShellTool, toolInputPath, type CallBucket } from "../../domain/tool-call-taxonomy.ts";
import {
  detectRedundantReads,
  detectSameFileRereads,
  isContentReadTool,
  readWindowOf,
  summarizeCallSequence,
  type CallRecord,
  type ReadWriteEvent,
} from "../../domain/call-sequence.ts";
import { indexPromptLines, isProvidedByPrompt, sampleReadOutput } from "../../domain/provided-context.ts";
import { callFingerprint } from "./call-fingerprint.ts";
import { buildTurnCallMetrics, type TurnCallMetrics, type TurnUsage } from "../../domain/turn-efficiency-summary.ts";
import {
  TOOL_SEQUENCE_MAX_ENTRIES,
  TOOL_TARGET_MAX_CHARS,
  isPermissionDenial,
  toolCallSubject,
  type ToolSequenceEntry,
} from "../../domain/tool-sequence.ts";
import { sanitizeText } from "../../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { NAV_OUTCOME_READ_CHARS, isNavigationCall } from "../../domain/nav-outcome.ts";
import { TRACE_MAX_ENTRIES, type CallStatus, type CallTrace, type StepTrace, type StepUsageTrace, type TurnTrace } from "../../domain/turn-trace.ts";

interface PartLike {
  id?: string;
  type?: string;
  sessionID?: string;
  messageID?: string;
  callID?: string;
  tool?: string;
  state?: { status?: string; input?: unknown; output?: unknown; error?: unknown; time?: { start?: unknown; end?: unknown } };
  /** step-finish parts only. */
  reason?: unknown;
  tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } };
  cost?: unknown;
}

/** What one finished step spent. */
type StepUsage = StepUsageTrace;

/** One step as the stream showed it; the trace of a turn is the records since the previous flush. */
interface StepRecord {
  /* The step's number in the session, counted from 0 and never reused. */
  seq: number;
  startedAt: number | null;
  finishedAt: number | null;
  reason: string | null;
  usage: StepUsage | null;
  callIds: string[];
}

interface TrackedCall {
  callId: string;
  /** The assistant message the call belongs to, as the stream reported it. */
  messageId?: string;
  tool: string;
  bucket: CallBucket;
  /** Whether the call went through a shell tool, whatever its command line did. */
  shellCall: boolean;
  repeatKey: string;
  path?: string;
  window?: string;
  /** What the call pointed at, resolved against the session's directory, redacted and capped. */
  target: { target: string | null; scope?: string; kind: CallTrace["targetKind"]; relPath?: string };
  /** When the call was first seen running or completed, by the tracker's clock. */
  firstSeenAt: number;
  /** The latest sighting's status, the runtime's own start and end times, and the absolute index (in the session) of the step open when the call was first seen. */
  status: CallStatus;
  startedAt: number | null;
  endedAt: number | null;
  stepAbs: number | null;
  /** A bounded prefix of a navigation's answer, kept for the outcome classifier. */
  navOutput?: string;
  /** Whether the runtime refused the call under a permission rule. */
  denied: boolean;
  /** Up to PROVIDED_CONTEXT_SAMPLE_LINES normalized lines of a completed content read. */
  sample?: string[];
  /** The first GRAPH_ANSWER_KEPT_CHARS of a completed code-graph answer, the source it showed the agent. */
  graphAnswer?: string;
}

/* A code-graph answer is capped by the orchestrator well below this; the bound only keeps a runaway answer from growing the session's memory. */
const GRAPH_ANSWER_KEPT_CHARS = 64 * 1024;

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
  /** When the turn in flight was first prepared; null until then and after each flush. */
  turnStartedAt: number | null;
  /** Every call the runtime refused, whether or not it ever ran; only grows. */
  deniedIds: Set<string>;
  flushedDenied: number;
  /** Every finished step seen, by part id, the latest sighting of a part winning. */
  stepUsage: Map<string, StepUsage>;
  /** The steps already counted by an earlier flush. */
  flushedUsageIds: Set<string>;
  /** Every step seen, in order, and the one still open; only the turn in flight's records are held, capped at TRACE_MAX_ENTRIES; an earlier turn's are let go when it is flushed. */
  stepRecords: StepRecord[];
  openStep: StepRecord | null;
  finishedParts: Map<string, StepRecord>;
  /* The number the next step takes, and the number of the first step of the turn in flight. */
  nextStepSeq: number;
  turnFirstStepSeq: number;
  /* More steps happened in the turn than are kept. */
  stepsTruncated: boolean;
  /* Navigation answers kept in the turn in flight. */
  navKept: number;
}

/* The most navigation answers one turn keeps for the outcome classifier. */
export const NAV_OUTPUT_MAX_KEPT = 100;

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
    turnStartedAt: null,
    deniedIds: new Set(),
    flushedDenied: 0,
    stepUsage: new Map(),
    flushedUsageIds: new Set(),
    stepRecords: [],
    openStep: null,
    finishedParts: new Map(),
    nextStepSeq: 0,
    turnFirstStepSeq: 0,
    stepsTruncated: false,
    navKept: 0,
  };
}

/* A finite, non-negative number or nothing: a malformed figure is dropped rather than summed. */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/* The usage of one step-finish part, or undefined when its figures are not numbers. */
function stepUsageOf(part: PartLike): StepUsage | undefined {
  const input = count(part.tokens?.input);
  const output = count(part.tokens?.output);
  const cost = count(part.cost);
  if (input === undefined || output === undefined || cost === undefined) return undefined;
  return {
    input,
    output,
    reasoning: count(part.tokens?.reasoning) ?? 0,
    cacheRead: count(part.tokens?.cache?.read) ?? 0,
    cacheWrite: count(part.tokens?.cache?.write) ?? 0,
    cost,
  };
}

function sumUsage(steps: readonly StepUsage[]): TurnUsage {
  const total: TurnUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, steps: steps.length };
  for (const step of steps) {
    total.input += step.input;
    total.output += step.output;
    total.reasoning += step.reasoning;
    total.cacheRead += step.cacheRead;
    total.cacheWrite += step.cacheWrite;
    total.cost += step.cost;
  }
  return total;
}

/* Redaction runs on a bounded prefix, so a pathological input costs a bounded amount. */
const TARGET_REDACTION_WINDOW_CHARS = 1_000;

/* A target is untrusted text from the agent: redacted like every text that leaves the system, then capped. A fault in redaction yields a marker, never the raw text. */
function safeTarget(raw: string): string {
  try {
    return sanitizeText(raw.slice(0, TARGET_REDACTION_WINDOW_CHARS)).text.slice(0, TOOL_TARGET_MAX_CHARS);
  } catch {
    return "[redacted]";
  }
}

/* A path inside the session's directory reads relative to it; one outside stays absolute so a read outside the working copy is visible. */
function displayPath(raw: string, cwd: string): string {
  const absolute = resolve(cwd, raw);
  const inside = relative(cwd, absolute);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? inside : absolute;
}

function describeTarget(input: unknown, cwd: string): TrackedCall["target"] {
  const subject = toolCallSubject(input);
  if (!subject) return { target: null, kind: null };
  const value = subject.kind === "path" ? displayPath(subject.value, cwd) : subject.value;
  return {
    target: safeTarget(value),
    kind: subject.kind,
    ...(subject.kind === "path" && !isAbsolute(value) ? { relPath: value } : {}),
    ...(subject.scope !== undefined ? { scope: safeTarget(displayPath(subject.scope, cwd)) } : {}),
  };
}

/* A runtime-stamped time: a finite, non-negative number of epoch milliseconds, or nothing. */
function stamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function toCallRecord(call: TrackedCall): CallRecord {
  return { callId: call.callId, status: "completed", bucket: call.bucket, shellCall: call.shellCall, repeatKey: call.repeatKey };
}

function toSequenceEntry(call: TrackedCall): ToolSequenceEntry {
  return {
    tool: call.tool.slice(0, TOOL_TARGET_MAX_CHARS),
    target: call.target.target,
    ...(call.target.scope !== undefined ? { scope: call.target.scope } : {}),
    ...(call.window && isContentReadTool(call.tool) ? { window: call.window.slice(0, TOOL_TARGET_MAX_CHARS) } : {}),
    ...(call.denied ? { denied: true as const } : {}),
  };
}

function toReadWriteEvent(call: TrackedCall): ReadWriteEvent {
  return { callId: call.callId, status: "completed", bucket: call.bucket, tool: call.tool, ...(call.path ? { path: call.path } : {}), ...(call.window ? { window: call.window } : {}) };
}

export class CallEfficiencyTracker implements StreamLifecycleSink {
  private readonly sessions = new Map<string, SessionState>();
  private readonly streams = new Map<string, DirectoryStream>();
  private readonly timer: TrackerTimer;
  private readonly now: () => number;

  constructor(options: { timer?: TrackerTimer; now?: () => number } = {}) {
    this.timer = options.timer ?? realTimer;
    this.now = options.now ?? Date.now;
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
    /* A turn is timed from its first attempt; a retry, and a prompt abandoned before it flushed, keep the start they began with. */
    if (attempt === 0 && session.turnStartedAt === null) session.turnStartedAt = this.now();
    if (attempt > 0) return;
    session.flushedSteps = session.stepStarts.size;
    this.startTurnRecords(session);
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
      engineLog.error(
        `[qa] call-efficiency tracking failed for session ${sessionId}; its efficiency metrics are dropped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private apply(session: SessionState, part: PartLike): void {
    if (part.type === "step-start") {
      const seenBefore = part.id !== undefined && session.stepStarts.has(part.id);
      if (part.id) session.stepStarts.add(part.id);
      if (!seenBefore) session.openStep = this.addStep(session, this.now());
      session.sawEventSinceFlush = true;
      return;
    }
    if (part.type === "step-finish") {
      const usage = stepUsageOf(part);
      if (part.id && usage) session.stepUsage.set(part.id, usage);
      this.finishStep(session, part, usage);
      session.sawEventSinceFlush = true;
      return;
    }
    if (part.type !== "tool" || !part.callID || !part.tool) return;
    session.sawEventSinceFlush = true;

    const status = part.state?.status;
    if (status !== "running" && status !== "completed" && status !== "error") return;

    let call = session.calls.get(part.callID);
    if (status === "error" && isPermissionDenial(part.state?.error)) {
      session.deniedIds.add(part.callID);
      if (call) call.denied = true;
    }
    /* A call counts from its first running/completed sighting; an error with no prior
       running sighting never entered the sequence. */
    if (!call && status === "error") return;

    /* A call is identified by its latest sighting's input. */
    const input = part.state?.input;
    const seen = {
      repeatKey: callFingerprint(part.tool, input),
      bucket: bucketForTool(part.tool, input),
      shellCall: isShellTool(part.tool),
      path: pathOf(input, session.cwd),
      window: readWindowOf(input),
      target: describeTarget(input, session.cwd),
    };
    if (call) {
      Object.assign(call, seen);
    } else {
      const open = session.openStep;
      call = {
        callId: part.callID,
        ...(typeof part.messageID === "string" && part.messageID !== "" ? { messageId: part.messageID.slice(0, 200) } : {}),
        tool: part.tool,
        firstSeenAt: this.now(),
        denied: session.deniedIds.has(part.callID),
        status,
        startedAt: null,
        endedAt: null,
        stepAbs: open ? open.seq : null,
        ...seen,
      };
      open?.callIds.push(part.callID);
      session.calls.set(part.callID, call);
      session.order.push(part.callID);
    }
    call.status = status;
    call.startedAt = stamp(part.state?.time?.start) ?? call.startedAt;
    call.endedAt = stamp(part.state?.time?.end) ?? call.endedAt;
    if (status !== "running" && isNavigationCall(part.tool) && (call.navOutput !== undefined || session.navKept < NAV_OUTPUT_MAX_KEPT)) {
      const answer = status === "completed" ? part.state?.output : part.state?.error;
      if (typeof answer === "string") {
        if (call.navOutput === undefined) session.navKept += 1;
        call.navOutput = answer.slice(0, NAV_OUTCOME_READ_CHARS);
      }
    }

    if (status === "completed" && isContentReadTool(part.tool) && typeof part.state?.output === "string") {
      call.sample = sampleReadOutput(part.state.output);
    }
    if (status === "completed" && isCodeGraphTool(part.tool) && typeof part.state?.output === "string") {
      call.graphAnswer = part.state.output.slice(0, GRAPH_ANSWER_KEPT_CHARS);
    }
  }

  /* Closes the step that is open (or records one whose start was not seen); a finish seen again updates its step, never adds one. */
  private finishStep(session: SessionState, part: PartLike, usage: StepUsage | undefined): void {
    const again = part.id !== undefined ? session.finishedParts.get(part.id) : undefined;
    const record = again ?? session.openStep ?? this.unopenedStep(session);
    if (!again) record.finishedAt = this.now();
    record.reason = typeof part.reason === "string" ? part.reason : record.reason;
    record.usage = usage ?? record.usage;
    if (part.id) session.finishedParts.set(part.id, record);
    if (session.openStep === record) session.openStep = null;
  }

  /* A step the turn keeps; past the cap it is counted as truncated and not kept (a record nobody holds is still returned so a finish has something to close). */
  private addStep(session: SessionState, startedAt: number | null): StepRecord {
    const record: StepRecord = { seq: session.nextStepSeq++, startedAt, finishedAt: null, reason: null, usage: null, callIds: [] };
    if (session.stepRecords.length < TRACE_MAX_ENTRIES) session.stepRecords.push(record);
    else session.stepsTruncated = true;
    return record;
  }

  private unopenedStep(session: SessionState): StepRecord {
    return this.addStep(session, null);
  }

  /* The turn about to start owns no step or answer of an earlier one; the records of those are let go. */
  private startTurnRecords(session: SessionState): void {
    session.stepRecords = [];
    session.finishedParts = new Map();
    session.openStep = null;
    session.turnFirstStepSeq = session.nextStepSeq;
    session.stepsTruncated = false;
    session.navKept = 0;
  }

  /* The turn's steps and calls since the previous flush, with step numbers counted from the turn's first. */
  private traceOf(session: SessionState, turnCalls: readonly TrackedCall[], startedAt: number | null): TurnTrace {
    const base = session.turnFirstStepSeq;
    const steps: StepTrace[] = session.stepRecords.map((record, i) => ({
      index: i + 1,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      reason: record.reason,
      usage: record.usage,
      callIds: [...record.callIds],
    }));
    const calls: CallTrace[] = turnCalls.slice(0, TRACE_MAX_ENTRIES).map((call) => ({
      callId: call.callId,
      ...(call.messageId !== undefined ? { messageId: call.messageId } : {}),
      tool: call.tool,
      bucket: call.bucket,
      status: call.status,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      firstSeenAt: call.firstSeenAt,
      step: call.stepAbs !== null && call.stepAbs >= base && call.stepAbs - base < steps.length ? call.stepAbs - base + 1 : null,
      denied: call.denied,
      targetKind: call.target.kind,
      target: call.target.target,
      ...(call.target.relPath !== undefined ? { relPath: call.target.relPath } : {}),
      ...(call.navOutput !== undefined ? { navOutput: call.navOutput } : {}),
    }));
    return {
      startedAt,
      firstStepAt: steps[0]?.startedAt ?? null,
      steps,
      calls,
      truncated: session.stepsTruncated || turnCalls.length > TRACE_MAX_ENTRIES,
    };
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
    const rereads = detectSameFileRereads(calls.map(toReadWriteEvent));
    const promptIndex = indexPromptLines(promptText);
    const provided = new Set(providedPaths?.map((p) => resolve(session.cwd, p)));
    const newSteps = session.stepStarts.size - session.flushedSteps;
    const finishedSteps = [...session.stepUsage].filter(([id]) => !session.flushedUsageIds.has(id));
    const sinceStart = (call: TrackedCall | undefined): number | null =>
      call && session.turnStartedAt !== null ? Math.max(0, call.firstSeenAt - session.turnStartedAt) : null;

    const metrics = buildTurnCallMetrics({
      sequence: { ...summarizeCallSequence(turnCalls.map(toCallRecord)), repeatedCallCount: duplicatesNow - duplicatesBefore },
      buckets: turnCalls.map((call) => call.bucket),
      redundantReadCount: turnCalls.filter((call) => redundant.has(call.callId)).length,
      sameFileReadCount: turnCalls.filter((call) => rereads.has(call.callId)).length,
      promptProvidedReadCount: turnCalls.filter((call) => call.sample && isProvidedByPrompt(call.sample, promptIndex)).length,
      pathProvidedReadCount: turnCalls.filter((call) => isContentReadTool(call.tool) && call.path !== undefined && provided.has(call.path)).length,
      graphProvidedReadCount: countGraphProvidedReads(calls, session.flushedCalls),
      stepsUsed: session.stepsComplete && newSteps > 0 ? newSteps : null,
      observationComplete: session.stepsComplete,
      timeToFirstCallMs: sinceStart(turnCalls[0]),
      timeToFirstWriteMs: sinceStart(turnCalls.find((call) => call.bucket === CALL_BUCKETS.WRITE)),
      deniedCallCount: session.deniedIds.size - session.flushedDenied,
      toolSequence: turnCalls.slice(0, TOOL_SEQUENCE_MAX_ENTRIES).map(toSequenceEntry),
      usage: session.stepsComplete && finishedSteps.length > 0 ? sumUsage(finishedSteps.map(([, usage]) => usage)) : null,
      trace: this.traceOf(session, turnCalls, session.turnStartedAt),
    });
    this.startTurnRecords(session);
    for (const [id] of finishedSteps) session.flushedUsageIds.add(id);

    session.flushedDenied = session.deniedIds.size;
    session.turnStartedAt = null;
    session.flushedCalls = calls.length;
    session.flushedSteps = session.stepStarts.size;
    session.sawEventSinceFlush = false;
    return metrics;
  }
}

/* The content reads at or after `from` whose lines a code-graph answer made earlier in the session had already shown. A read is compared only with the answers before it, so a read the agent made first and the graph repeated later is not counted. */
function countGraphProvidedReads(calls: readonly TrackedCall[], from: number): number {
  let shown: ReadonlySet<string> = new Set();
  let count = 0;
  calls.forEach((call, index) => {
    if (call.graphAnswer !== undefined) shown = new Set([...shown, ...indexPromptLines(call.graphAnswer)]);
    else if (index >= from && call.sample && isProvidedByPrompt(call.sample, shown)) count += 1;
  });
  return count;
}

export const callEfficiencyTracker = new CallEfficiencyTracker();
