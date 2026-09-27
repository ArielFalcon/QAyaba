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

/* Initial tail-read window; grows by TAIL_GROWTH_FACTOR each retry until enough matching events are
   found or the file start is reached. 16KB comfortably covers a poll's default/typical limit
   (200, clamped to 1000) worth of small JSONL lines on the first read. */
const INITIAL_TAIL_BYTES = 16 * 1024;
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
  let total = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;  /* corrupt/partial tail line — skip, never fail the read */
    }
    if (!isRecord(parsed) || typeof parsed.runId !== "string" || typeof parsed.kind !== "string"
      || typeof parsed.reason !== "string" || typeof parsed.at !== "number") continue;
    if (!KINDS.has(parsed.kind)) continue;
    if (filter.runId && parsed.runId !== filter.runId) continue;
    total++;
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
  return {
    runId: o.runId as string,
    kind: o.kind as CoordinationEvent["kind"],
    reason: o.reason as string,
    at: o.at as number,
    ...(optStr(o.action) ? { action: optStr(o.action) } : {}),
    ...(optStr(o.capability) ? { capability: optStr(o.capability) } : {}),
    ...(optInt(o.durationMs) !== undefined ? { durationMs: optInt(o.durationMs) } : {}),
    ...(optStr(o.delegationId) ? { delegationId: optStr(o.delegationId) } : {}),
    ...(optInt(o.attempt) !== undefined ? { attempt: optInt(o.attempt) } : {}),
    ...(optStr(o.failureClass) ? { failureClass: optStr(o.failureClass) } : {}),
    ...(optStr(o.progressFingerprint) ? { progressFingerprint: optStr(o.progressFingerprint) } : {}),
    ...(optStr(o.finalOutcome) ? { finalOutcome: optStr(o.finalOutcome) } : {}),
    ...(optStr(o.reviewOutcome) ? { reviewOutcome: optStr(o.reviewOutcome) } : {}),
    ...(typeof o.valueScore === "number" ? { valueScore: o.valueScore } : {}),
    ...(o.coverageRatio === null || typeof o.coverageRatio === "number"
      ? { coverageRatio: o.coverageRatio as number | null }
      : {}),
    ...(optInt(o.escalations) !== undefined ? { escalations: optInt(o.escalations) } : {}),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
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
   * whose claimed files never verified on disk — both would print "completed"/"blocked" without the
   * substrings the old regex looked for. A ledger line recorded before failureClass existed simply
   * has no opinion (undefined) and is not counted — lenient degradation on old data, not a hazard.
   */
  const failures = delegationEvents.filter((e) => typeof e.failureClass === "string").length;
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
 * `limit` of the most recent matches) or the file start is reached (nothing left to grow into). This
 * avoids the earlier readFileSync-the-whole-file-every-poll cost: a live /api/signals poll with the
 * default/typical limit reads a small tail chunk, not the entire (potentially large) historical file.
 * Correctness matches a full-file parse exactly in both stopping cases — see the two returns below.
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
      const buffer = Buffer.alloc(bytesToRead);
      if (bytesToRead > 0) fs.readSync(fd, buffer, 0, bytesToRead, position);
      /* A chunk that doesn't start at byte 0 may open mid-line; drop that partial first line — a
         wider re-read on the next growth pass will pick it up whole, from further back. */
      const text = position > 0 ? dropPartialFirstLine(buffer.toString("utf8")) : buffer.toString("utf8");
      const parsed = parseCoordinationLedger(text, filter);
      if (parsed.truncated || position === 0) return parsed;
      bytesToRead = Math.min(size, bytesToRead * TAIL_GROWTH_FACTOR);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function dropPartialFirstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx === -1 ? "" : text.slice(idx + 1);
}

/* Convenience alias for the api-deps wiring: bounded tail (limit clamps inside the reader). */
export function readRecentCoordinationEvents(filter: CoordinationEventsFilter = {}): CoordinationEventsView {
  return readCoordinationLedger(filter);
}
