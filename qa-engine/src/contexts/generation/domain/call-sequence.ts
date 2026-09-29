/*
 * Pure call-sequence analysis, reused identically by the fine
 * in-session tracker and the coarse post-hoc classifier so the metrics they
 * share reconcile by construction. Bucket classification itself lives in
 * `tool-call-taxonomy.ts` — this module only reasons about ORDER, identity
 * and repetition once a caller has already classified each call.
 */

import { CALL_BUCKETS, type CallBucket } from "./tool-call-taxonomy.ts";

export type CallStatus = "pending" | "running" | "completed" | "error";

export interface CallRecord {
  callId: string;
  status: CallStatus;
  bucket: CallBucket;
  /**
   * Identity used for exact-duplicate detection ("the same
   * tool with the same stable-stringified input"). The fine tracker passes
   * `tool + stable-stringified input`; the coarse classifier passes a
   * `(kind, target)` proxy, since the raw tool/path are not persisted —
   * this is why `repeatedCallCount` is NOT required to reconcile between
   * fine and coarse (only total/before-first-write/write/command/subagent are).
   */
  repeatKey: string;
}

export interface CallSequenceSummary {
  totalCalls: number;
  callsBeforeFirstWrite: number;
  writeCount: number;
  commandCount: number;
  subagentCount: number;
  repeatedCallCount: number;
}

/** A call counts once, at its FIRST sighting in `running` or `completed` — a
 *  callId seen only `pending` and/or `error` never counts. Order follows that
 *  first-valid-sighting position in the input array. */
function firstSeenInOrder<T extends { callId: string; status: CallStatus }>(
  sightings: readonly T[],
): T[] {
  const firstSeen = new Map<string, T>();
  for (const sighting of sightings) {
    if (sighting.status !== "running" && sighting.status !== "completed") continue;
    if (!firstSeen.has(sighting.callId)) firstSeen.set(sighting.callId, sighting);
  }
  return [...firstSeen.values()];
}

/**
 * Reduces a raw, possibly-repeated stream of call sightings into the shared
 * summary. `callsBeforeFirstWrite` counts calls STRICTLY before the first
 * write-bucket call (excluding the write call itself), so it equals
 * `totalCalls` when the turn has no write.
 */
export function summarizeCallSequence(sightings: readonly CallRecord[]): CallSequenceSummary {
  const calls = firstSeenInOrder(sightings);

  const seenRepeatKeys = new Set<string>();
  let callsBeforeFirstWrite = 0;
  let writeCount = 0;
  let commandCount = 0;
  let subagentCount = 0;
  let repeatedCallCount = 0;
  let firstWriteSeen = false;

  for (const call of calls) {
    if (seenRepeatKeys.has(call.repeatKey)) repeatedCallCount++;
    else seenRepeatKeys.add(call.repeatKey);

    if (!firstWriteSeen) {
      if (call.bucket === CALL_BUCKETS.WRITE) firstWriteSeen = true;
      else callsBeforeFirstWrite++;
    }

    if (call.bucket === CALL_BUCKETS.WRITE) writeCount++;
    else if (call.bucket === CALL_BUCKETS.VALIDATE_RUN) commandCount++;
    else if (call.bucket === CALL_BUCKETS.SUBAGENT) subagentCount++;
  }

  return {
    totalCalls: calls.length,
    callsBeforeFirstWrite,
    writeCount,
    commandCount,
    subagentCount,
    repeatedCallCount,
  };
}

export interface ReadWriteEvent {
  callId: string;
  status: CallStatus;
  bucket: CallBucket;
  /** Raw tool identifier — used only to recognize content-read tools. */
  tool: string;
  /** cwd-resolved absolute path this call touched, when applicable. */
  path?: string;
  /** For a read: which part of the file it asked for (readWindowOf); absent or "" is the whole file. */
  window?: string;
}

/* The keys a read uses to ask for part of a file: the native tool's `offset`/`limit` and Serena's `start_line`/`end_line`. A start of 0 is the default (the top of the file), not a request for a window. */
const WINDOW_START_KEYS = ["offset", "start_line"] as const;
const WINDOW_SIZE_KEYS = ["limit", "end_line"] as const;

/** Which part of a file a read asked for, as a stable string: "" for the whole file. Two reads of one path are the same read only if their windows are the same. */
export function readWindowOf(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of [...WINDOW_START_KEYS, ...WINDOW_SIZE_KEYS]) {
    const value = record[key];
    if (typeof value !== "number" && typeof value !== "string") continue;
    if ((WINDOW_START_KEYS as readonly string[]).includes(key) && Number(value) === 0) continue;
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join(",");
}

/* A "content-read tool": read, or *_read, or read_file / *_read_file. */
const CONTENT_READ_TOOL = /(^|_)read(_file)?$/i;

export function isContentReadTool(tool: string): boolean {
  return CONTENT_READ_TOOL.test(tool);
}

/**
 * Flags redundant reads (fine tracker only — the coarse
 * classifier has no raw paths to run this against). A content-read tool
 * re-reading the same window of a path already read, with no write to that path
 * in between, is redundant; reading another window of it is new content. A
 * write to a specific path clears redundancy for that path only (every window of
 * it); a write with NO path invalidates every previously-read path.
 */
export function detectRedundantReads(events: readonly ReadWriteEvent[]): ReadonlySet<string> {
  const calls = firstSeenInOrder(events);
  const readWindows = new Map<string, Set<string>>();
  const redundant = new Set<string>();

  for (const call of calls) {
    if (call.bucket === CALL_BUCKETS.WRITE) {
      if (call.path) readWindows.delete(call.path);
      else readWindows.clear();
      continue;
    }
    if (!call.path || !isContentReadTool(call.tool)) continue;
    const seen = readWindows.get(call.path) ?? new Set<string>();
    const window = call.window ?? "";
    if (seen.has(window)) redundant.add(call.callId);
    else readWindows.set(call.path, seen.add(window));
  }

  return redundant;
}
