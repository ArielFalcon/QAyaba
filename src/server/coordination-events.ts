/*
 * Coordination telemetry reader + aggregator. Pure functions (no I/O in the two
 * exported builders) — the orchestrator wires the REAL ledger file path at the call
 * site, unit-tested with fixture strings. The JSONL tail is the single source: qa-engine's own
 * FileCoordinationTelemetryAdapter holds the same records in-process, but only the file survives
 * process restarts, so the dashboard reads the file.
 */
import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import { resolveCoordinationTelemetryPath } from "./rewritten-engine-factory";
import type { CoordinationEvent, CoordinationEventsView, CoordinationSignals } from "../contract/commands";
import { DELEGATION_FAILURE_CLASSES } from "../../qa-engine/src/contexts/qa-run-orchestration/application/coordination/delegation-failure-class";

const CONTRACT_FAILURE_CLASSES: ReadonlySet<string> = new Set(DELEGATION_FAILURE_CLASSES);

const KINDS = new Set(["proposal", "delegation", "escalation", "router", "pushback", "outcome"]);

export interface CoordinationLedgerFsDeps {
  readonly openSync: typeof openSync;
  readonly fstatSync: typeof fstatSync;
  readonly readSync: typeof readSync;
  readonly closeSync: typeof closeSync;
}

export const defaultCoordinationLedgerFsDeps: CoordinationLedgerFsDeps = {
  openSync,
  fstatSync,
  readSync,
  closeSync,
};

/* Initial tail-read window (16 KiB); grows by TAIL_GROWTH_FACTOR each retry until enough matching
   events are found or the file start is reached. It comfortably covers a poll's default/typical
   limit (200, clamped to 1000) worth of small JSONL lines on the first read. */
const INITIAL_TAIL_BYTES = 16_384;
const TAIL_GROWTH_FACTOR = 8;

export interface CoordinationEventsFilter {
  readonly runId?: string;
  readonly limit?: number;
}

/*
 * parseCoordinationLedger reads a JSONL coordination ledger, filters by runId (newest
 * last → returned oldest-first within the tail), coerces the truncated flag, and
 * silently drops malformed lines (a partial append must never 500 an audit endpoint).
 */
export function parseCoordinationLedger(
  raw: string,
  filter: CoordinationEventsFilter = {},
): { events: CoordinationEvent[]; truncated: boolean } {
  const limit = clampLimit(filter.limit);
  const lines = raw.split("\n");
  const matched: CoordinationEvent[] = [];
  for (const line of lines) {
    /* JSON.parse ignores surrounding whitespace (a CRLF line parses) and rejects a blank line. */
    let parsed: { [key: string]: unknown } | null | undefined;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;  /* corrupt/partial tail line — skip, never fail the read */
    }
    /* null, a number, a string or an array has no string runId, so every non-object line is dropped here. */
    if (typeof parsed?.runId !== "string" || typeof parsed.kind !== "string"
      || typeof parsed.reason !== "string" || typeof parsed.at !== "number") continue;
    if (!KINDS.has(parsed.kind)) continue;
    if (filter.runId && parsed.runId !== filter.runId) continue;
    matched.push(coerce(parsed));
  }
  if (limit < matched.length) {
    return { events: matched.slice(matched.length - limit), truncated: true };
  }
  return { events: matched, truncated: false };
}

function coerce(o: Record<string, unknown>): CoordinationEvent {
  const optInt = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  /* An invalid count is an undefined value, which serializes exactly like an absent key. */
  return {
    runId: o.runId as string,
    kind: o.kind as CoordinationEvent["kind"],
    reason: o.reason as string,
    at: o.at as number,
    ...(optStr(o.action) ? { action: optStr(o.action) } : {}),
    ...(optStr(o.capability) ? { capability: optStr(o.capability) } : {}),
    durationMs: optInt(o.durationMs),
    ...(optStr(o.delegationId) ? { delegationId: optStr(o.delegationId) } : {}),
    attempt: optInt(o.attempt),
    ...(optStr(o.failureClass) ? { failureClass: optStr(o.failureClass) } : {}),
    ...(optStr(o.progressFingerprint) ? { progressFingerprint: optStr(o.progressFingerprint) } : {}),
    ...(optStr(o.finalOutcome) ? { finalOutcome: optStr(o.finalOutcome) } : {}),
    ...(optStr(o.reviewOutcome) ? { reviewOutcome: optStr(o.reviewOutcome) } : {}),
    ...(typeof o.valueScore === "number" ? { valueScore: o.valueScore } : {}),
    ...(o.coverageRatio === null || typeof o.coverageRatio === "number"
      ? { coverageRatio: o.coverageRatio as number | null }
      : {}),
    escalations: optInt(o.escalations),
  };
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return 200;
  return Math.min(Math.floor(limit), 1000);
}

/*
 * toCoordinationSignals aggregates the ledger into the SIGNALS panel block. Sample =
 * events belonging to runs the fleet executed (the caller decides the window). A
 * DelegationOutcome is the run-scoped boundary (one per run), so delegate share is the
 * share of outcome events whose action is "delegate".
 */
export function toCoordinationSignals(events: readonly CoordinationEvent[]): CoordinationSignals {
  const delegationEvents = events.filter((e) => e.kind === "delegation");
  const outcomes = events.filter((e) => e.kind === "outcome");
  const runIds = new Set(outcomes.map((e) => e.runId));
  const delegateRunIds = new Set(outcomes.filter((e) => e.action === "delegate").map((e) => e.runId));
  const escalations = new Set(
    events
      .filter((e) => e.kind === "escalation" && typeof e.escalations === "number")
      .map((e) => `${e.runId}:${e.escalations}`),
  );
  /*
   * A delegation contract failure is read from the typed failureClass field (set by
   * classifyDelegationFailure in qa-engine — "failed" | "blocked" | "claimed-files-missing"), never
   * guessed from the free-text `reason` prose. The prose only ever reads "sidekick status=<X>" and
   * a regex over it could never distinguish, say, a pushback-blocked delegation from a completed one
   * whose claimed files never verified on disk. Only a delegation failure class counts: a line with no
   * failureClass, or with a value outside that set (older ledgers wrote "fail" on every fix-loop
   * delegation, successful ones included), has no opinion and is not counted.
   */
  const failures = delegationEvents.filter(
    (e) => e.failureClass !== undefined && CONTRACT_FAILURE_CLASSES.has(e.failureClass),
  ).length;
  const timed = delegationEvents.filter((e) => typeof e.durationMs === "number");
  const totalRuns = runIds.size;
  const delegateRuns = delegateRunIds.size;
  return {
    measured: outcomes.length > 0,
    totalRuns,
    delegateRuns,
    escalationRate: delegateRuns > 0
      ? round4(escalations.size / delegateRuns)
      : null,
    contractFailureRate: delegationEvents.length > 0
      ? round4(failures / delegationEvents.length)
      : null,
    avgDelegationMs: timed.length > 0
      ? Math.round(timed.reduce((s, e) => s + (e.durationMs ?? 0), 0) / timed.length)
      : null,
  };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/*
 * I/O wrapper the control plane wires in: reads the CURRENT durable ledger (the same path
 * composition writes to) and returns the filtered view. A missing file (fresh install, or
 * coordination did not record anything yet) is an empty ledger — never an error.
 */
export function readCoordinationLedger(
  filter: CoordinationEventsFilter = {},
  path: string = resolveCoordinationTelemetryPath(),
  fsDeps: CoordinationLedgerFsDeps = defaultCoordinationLedgerFsDeps,
): CoordinationEventsView {
  try {
    return readLedgerTail(path, filter, fsDeps);
  } catch (err) {
    if (isEnoent(err)) return { events: [], truncated: false };  /* absent file on first boot — normal cold start, not an error */
    console.error(`[qa] coordination ledger read failed (path=${path}): ${err instanceof Error ? err.message : String(err)}`);
    throw err;  /* surface integration errors loudly — never fabricate an empty ledger over a real fault */
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/*
 * Reads a bounded window from the END of the ledger file, growing it until either enough matching
 * events are found (parseCoordinationLedger reports truncated=true — i.e. we already hold at least
 * `limit` of the most recent matches) or the file start is reached (nothing left to grow into).
 *
 * There is a single writer per ledger (the long-lived service; a standalone CLI run always
 * delegates to it rather than appending to this file itself), but a runId filter still CANNOT stop
 * early on a contiguity assumption — this run's own events are not guaranteed to be a contiguous
 * block within the file. A runId-scoped read therefore keeps growing until `truncated || position
 * === 0`, i.e. it degrades to exact full-parse semantics, the same as the unfiltered path. The
 * bound on how much a full read can ever cost is the ledger's own size cap (MAX_LEDGER_EVENTS
 * rotation in qa-engine/.../coordination-telemetry-port.adapter.ts) — the file never grows past
 * that, so the worst case is a full read of a capped file, not an unbounded one.
 */
function readLedgerTail(
  path: string,
  filter: CoordinationEventsFilter,
  fs: CoordinationLedgerFsDeps,
): { events: CoordinationEvent[]; truncated: boolean } {
  const fd = fs.openSync(path, "r");
  try {
    const size = fs.fstatSync(fd).size;
    let bytesToRead = Math.min(size, INITIAL_TAIL_BYTES);
    for (;;) {
      const position = size - bytesToRead;
      /* A window that does not start at byte 0 may open mid-line. That partial first line never
         parses (a proper suffix of a JSON-object line leaves the outer closing brace unmatched), and
         a complete first line is the oldest in the window: whenever it could still be among the
         `limit` newest matches, the growth pass re-reads it from further back. */
      const chunk = readWindow(fs, fd, position, bytesToRead).toString("utf8");
      const parsed = parseCoordinationLedger(chunk, filter);
      if (parsed.truncated || position === 0) return parsed;
      bytesToRead = Math.min(size, bytesToRead * TAIL_GROWTH_FACTOR);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/* readSync may return fewer bytes than asked for: keep reading until a read returns nothing — the
   window is full (a zero-length read) or the file ended — and return only the bytes actually read,
   never the unfilled tail of the buffer. */
function readWindow(fs: CoordinationLedgerFsDeps, fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  let read: number;
  while ((read = fs.readSync(fd, buffer, filled, length - filled, position + filled)) > 0) filled += read;
  return buffer.subarray(0, filled);
}

/* Convenience alias for the api-deps wiring: bounded tail (limit clamps inside the reader). */
export function readRecentCoordinationEvents(filter: CoordinationEventsFilter = {}): CoordinationEventsView {
  return readCoordinationLedger(filter);
}
