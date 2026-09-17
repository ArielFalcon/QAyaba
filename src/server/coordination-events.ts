/*
 * Coordination telemetry reader + aggregator. Pure functions (no I/O in the two
 * exported builders) — the orchestrator wires the REAL ledger file path at the call
 * site, unit-tested with fixture strings. The JSONL tail is the single source: the
 * InMemory store inside qa-engine holds the same records in-process, but only the
 * file survives process restarts, so the dashboard reads the file.
 */
import { readFileSync } from "node:fs";
import { resolveCoordinationTelemetryPath } from "./rewritten-engine-factory";
import type { CoordinationEvent, CoordinationEventsView, CoordinationSignals } from "../contract/commands";

const KINDS = new Set(["proposal", "delegation", "escalation", "router", "pushback", "outcome"]);

export interface CoordinationEventsFilter {
  readonly runId?: string;
  readonly limit?: number;
}

interface RawCoordinationEvent {
  runId?: unknown;
  kind?: unknown;
  action?: unknown;
  capability?: unknown;
  reason?: unknown;
  durationMs?: unknown;
  delegationId?: unknown;
  attempt?: unknown;
  failureClass?: unknown;
  progressFingerprint?: unknown;
  finalOutcome?: unknown;
  reviewOutcome?: unknown;
  escalations?: unknown;
  at?: unknown;
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
  const failures = delegationEvents.filter(
    (e) => typeof e.reason === "string" && /status=failed|violat|outside scope|claimed/i.test(e.reason),
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
export function readCoordinationLedger(filter: CoordinationEventsFilter = {}, path: string = resolveCoordinationTelemetryPath()): CoordinationEventsView {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { events: [], truncated: false };
  }
  return parseCoordinationLedger(raw, filter);
}

/* Convenience alias for the api-deps wiring: bounded tail (limit clamps inside the reader). */
export function readRecentCoordinationEvents(filter: CoordinationEventsFilter = {}): CoordinationEventsView {
  return readCoordinationLedger(filter);
}
