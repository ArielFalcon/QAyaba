/*
 * Which live location right a session belongs to. The orchestrator learns an agent session's id only when the session
 * opens (the agent transport reports every session it opens for a run), so the right is bound to the id at that moment;
 * the tools endpoint then finds the run's location by the session id the tool reports. The lead's session moves the run's
 * location; a sidekick's session moves only the flow it was opened for. A session no run owns, or one of a role that does
 * not author, finds nothing.
 */

import { AGENT_BROWSER_AGENTS } from "@contexts/test-execution/application/index.ts";
import { RUN_SPEC_FLOW_AGENT } from "@contexts/test-execution/application/index.ts";
import type { GeolocationInput } from "@kernel/geolocation.ts";
import type { GeolocationResult, RunGeolocation } from "../domain/run-geolocation.ts";
import type { OpenedSession } from "./closed-loop-registry.ts";

export interface LiveGeolocation {
  runId: string;
  state: RunGeolocation;
  /* Serves one change inside the run's own scope (its sandbox, its secrets), whatever request brought it. */
  set(delegationId: string | undefined, change: GeolocationInput): GeolocationResult;
}

export interface BoundGeolocation {
  live: LiveGeolocation;
  /* The role the session was opened for: the tool may only be used under that role. */
  agent: string;
  /* The flow of a plan the session was opened for; absent is the run's own lead. */
  delegationId?: string;
}

export class GeolocationRegistry {
  private readonly runs = new Map<string, LiveGeolocation>();
  private readonly sessions = new Map<string, BoundGeolocation>();

  register(live: LiveGeolocation): void {
    if (this.runs.has(live.runId)) throw new Error(`a geolocation right is already open for run ${live.runId}`);
    this.runs.set(live.runId, live);
  }

  unregister(runId: string): void {
    this.runs.delete(runId);
    for (const [sessionId, bound] of this.sessions) if (bound.live.runId === runId) this.sessions.delete(sessionId);
  }

  /* Gives a sidekick's session opened for a flow the right to change the location of that flow. Any other role's session, a session with no flow (the run's own author included), and a session of a run without a location get nothing. */
  bindSession(session: OpenedSession): void {
    if (!AGENT_BROWSER_AGENTS.has(session.agent)) return;
    if (session.delegationId === undefined || session.agent !== RUN_SPEC_FLOW_AGENT) return;
    const live = this.runs.get(session.runId);
    if (!live) return;
    this.sessions.set(session.sessionId, { live, agent: session.agent, ...(session.delegationId !== undefined ? { delegationId: session.delegationId } : {}) });
  }

  unbindSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  find(sessionId: string): BoundGeolocation | undefined {
    return this.sessions.get(sessionId);
  }

  get size(): number {
    return this.runs.size;
  }
}
