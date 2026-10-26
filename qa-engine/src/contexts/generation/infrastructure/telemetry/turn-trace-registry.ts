/*
 * Which turn is in flight on which session. The transport policy tells its trace about a prompt by session id and prompt number
 * (it cannot see the facade above it), and a layer above it (the stall watchdog) names the limit it fired the same way. The
 * facade decorator begins a probe when a prompt starts; the first event of the transport's next prompt binds the most recent
 * unbound probe to that prompt's number, so an event of an earlier prompt that arrives late (an attempt that outlived its turn) is
 * routed to the turn it belongs to and never to the current one.
 */
import { engineLog } from "@kernel/ports/process-logger.ts";
import type { TurnLimit } from "@kernel/turn-limit.ts";
import type { SpanHandle } from "@kernel/telemetry/telemetry.port.ts";
import type { ServerToolCall, ToolAttemptDirectory } from "../../domain/tool-link.ts";
import type { AttemptEvent } from "../agent-transport-policy.ts";
import type { TurnProbe } from "./turn-probe.ts";

/* Longer than the longest run budget (the exhaustive row, 150 min) plus a margin: a session older than this has outlived any run that could own it. */
export const DEFAULT_TRACE_MAX_AGE_MS = 4 * 60 * 60 * 1000;

interface SessionTurns {
  /* When a turn last began on the session. */
  touchedAt: number;
  /* The turn begun last, which a layer above the transport names limits on. */
  current: TurnProbe | undefined;
  /* Begun but not yet heard from the transport. */
  pending: TurnProbe | undefined;
  bound: Map<number, TurnProbe>;
}

export class AgentTurnTraces implements ToolAttemptDirectory {
  private readonly bySession = new Map<string, SessionTurns>();

  constructor(private readonly options: { now?: () => number; maxAgeMs?: number } = {}) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /* Forgets the sessions nobody disposed (a run that died, a leak), closing whatever they left open. Runs on each new turn. */
  private sweep(): void {
    const limit = this.now() - (this.options.maxAgeMs ?? DEFAULT_TRACE_MAX_AGE_MS);
    for (const [sessionId, turns] of this.bySession) {
      if (turns.touchedAt >= limit) continue;
      const probes = new Set([turns.current, turns.pending, ...turns.bound.values()]);
      for (const probe of probes) {
        try {
          probe?.closeAll();
        } catch (err) {
          engineLog.error(`[qa] a stale turn trace could not be closed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.bySession.delete(sessionId);
    }
  }

  private turns(sessionId: string): SessionTurns {
    let turns = this.bySession.get(sessionId);
    if (!turns) {
      turns = { touchedAt: this.now(), current: undefined, pending: undefined, bound: new Map() };
      this.bySession.set(sessionId, turns);
    }
    return turns;
  }

  begin(sessionId: string, probe: TurnProbe): void {
    this.sweep();
    const turns = this.turns(sessionId);
    turns.touchedAt = this.now();
    for (const [prompt, bound] of turns.bound) if (bound.isDone()) turns.bound.delete(prompt);
    turns.current = probe;
    turns.pending = probe;
  }

  /* Forgets the session. */
  end(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  attempt(sessionId: string, event: AttemptEvent): void {
    const turns = this.bySession.get(sessionId);
    if (!turns) return;
    if (event.kind === "start" && event.attempt === 1 && !turns.bound.has(event.prompt) && turns.pending) {
      turns.bound.set(event.prompt, turns.pending);
      turns.pending = undefined;
    }
    turns.bound.get(event.prompt)?.onAttempt(event);
  }

  /* A layer above the transport fired a limit on the session's turn in flight. */
  fired(sessionId: string, limit: TurnLimit): void {
    this.bySession.get(sessionId)?.current?.limit(limit);
  }

  firedBy(sessionId: string, prompt: number): TurnLimit | undefined {
    return this.bySession.get(sessionId)?.bound.get(prompt)?.firedByOuter();
  }

  /* The attempt span the session's turn is in right now: where a tool call the orchestrator serves for the session hangs. */
  attemptSpan(sessionId: string): SpanHandle | undefined {
    return this.bySession.get(sessionId)?.current?.liveAttempt();
  }

  noteToolCall(sessionId: string, call: ServerToolCall): void {
    this.bySession.get(sessionId)?.current?.noteToolCall(call);
  }

  size(): number {
    return this.bySession.size;
  }
}

/* The process-wide registry: the engine's decorator and the host's transport share it. */
export const agentTurnTraces = new AgentTurnTraces();
