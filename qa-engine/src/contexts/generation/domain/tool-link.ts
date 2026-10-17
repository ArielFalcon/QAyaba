/*
 * Which server span answered which tool call. A tool call of the agent (`run_spec`, `authbrowser_*`) is a synthesized
 * `execute_tool` span built from the event stream once the turn is over; the orchestrator's own span for the same call
 * (`qayaba.tool.*`, SERVER kind) was opened live, while the call was being served. They live in different containers and share
 * no trace context, so they are joined by what both sides know: the session (the registry is per session), the tool, the
 * assistant message the call belongs to when both sides carry it, and the time the call ran.
 *
 * A join that cannot be made safely is not made: a link that points at the wrong call is worse than none.
 */
import type { SpanHandle, TelemetryContext } from "@kernel/telemetry/telemetry.port.ts";

/* How far the two sides' clocks and the HTTP hop may disagree. Both run on one host; the agent's times are OpenCode's own stamps. */
export const LINK_TOLERANCE_MS = 1_000;

/* One call the orchestrator served for a session, as its server span recorded it. Times are wall-clock ms. */
export interface ServerToolCall {
  /* The agent-side tool name: `run_spec`, or `authbrowser_<action>`. */
  tool: string;
  /* The assistant message the tool reported; absent when the caller sent none. */
  messageId?: string;
  startedAt: number;
  endedAt: number;
  context: TelemetryContext;
}

/* What the event stream knows of a call. */
export interface LinkableCall {
  callId: string;
  tool: string;
  messageId?: string;
  /* The runtime's own start and end for the call; null when it reported none (the end stays null for a call still running). */
  startedAt: number | null;
  endedAt: number | null;
  firstSeenAt: number;
}

/* Where the orchestrator learns which span of an agent turn is live for a session, and tells it about the calls it served. */
export interface ToolAttemptDirectory {
  /* The attempt span the session's turn is in right now, or undefined when the session is not in an attempt. */
  attemptSpan(sessionId: string): SpanHandle | undefined;
  /* Records a served call against the session's turn, for the link its synthesized span will carry. */
  noteToolCall(sessionId: string, call: ServerToolCall): void;
}

interface Pair {
  call: LinkableCall;
  server: ServerToolCall;
  /* A message id both sides carry and agree on outranks a join by time alone. */
  exact: boolean;
  distance: number;
}

function overlaps(call: LinkableCall, server: ServerToolCall): boolean {
  const start = call.startedAt ?? call.firstSeenAt;
  const end = call.endedAt ?? Number.POSITIVE_INFINITY;
  return server.startedAt <= end + LINK_TOLERANCE_MS && server.endedAt >= start - LINK_TOLERANCE_MS;
}

/* The server span each call joins, by call id. A call and a span are each used at most once. */
export function matchServerCalls(calls: readonly LinkableCall[], servers: readonly ServerToolCall[]): Map<string, ServerToolCall> {
  const pairs: Pair[] = [];
  for (const call of calls) {
    for (const server of servers) {
      if (server.tool !== call.tool) continue;
      const bothKnow = call.messageId !== undefined && server.messageId !== undefined;
      if (bothKnow && call.messageId !== server.messageId) continue;
      if (!overlaps(call, server)) continue;
      pairs.push({ call, server, exact: bothKnow, distance: Math.abs(server.startedAt - (call.startedAt ?? call.firstSeenAt)) });
    }
  }
  pairs.sort((a, b) => Number(b.exact) - Number(a.exact) || a.distance - b.distance);

  const joined = new Map<string, ServerToolCall>();
  const used = new Set<ServerToolCall>();
  /* Two pairs at the same rank that share a call, or share a span, cannot be told apart: neither side of either is joined. */
  const ambiguousCalls = new Set<string>();
  const ambiguousServers = new Set<ServerToolCall>();
  for (const pair of pairs) {
    for (const other of pairs) {
      if (other === pair || other.exact !== pair.exact || other.distance !== pair.distance) continue;
      if (other.call === pair.call) ambiguousCalls.add(pair.call.callId);
      if (other.server === pair.server) ambiguousServers.add(pair.server);
    }
  }
  for (const pair of pairs) {
    if (ambiguousCalls.has(pair.call.callId) || ambiguousServers.has(pair.server) || joined.has(pair.call.callId) || used.has(pair.server)) continue;
    joined.set(pair.call.callId, pair.server);
    used.add(pair.server);
  }
  return joined;
}
