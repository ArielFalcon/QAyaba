/*
 * Which live code-graph right a session belongs to. The orchestrator learns an agent session's id only when the session opens
 * (the agent transport reports every session it opens for a run), so the right is bound to the id at that moment; the tools
 * endpoint then finds the run's graph by the session id the tool reports. Two roles are bound: the lead's own sessions (those
 * that name no delegation: the plan, its review and its corrections) and an explore sidekick's session, only with the delegation
 * it was opened for. An author sidekick, the lead's session for a flow and every other role find nothing.
 */

import { CODE_GRAPH_EXPLORE_AGENT, CODE_GRAPH_LEAD_AGENT } from "@kernel/code-graph-tools.ts";
import type { CodeGraphToolRequest, CodeGraphToolResponse } from "../domain/code-graph-query.ts";
import type { OpenedSession } from "./closed-loop-registry.ts";

export interface LiveCodeGraph {
  runId: string;
  /* Serves one call on the run's own project, inside the run's own scope, whatever request brought it. */
  call(request: CodeGraphToolRequest): Promise<CodeGraphToolResponse>;
}

export class CodeGraphToolRegistry {
  private readonly graphs = new Map<string, LiveCodeGraph>();
  private readonly sessions = new Map<string, string>();
  private readonly delegations = new Map<string, string>();

  register(graph: LiveCodeGraph): void {
    if (this.graphs.has(graph.runId)) throw new Error(`a code graph is already granted for run ${graph.runId}`);
    this.graphs.set(graph.runId, graph);
  }

  unregister(runId: string): void {
    this.graphs.delete(runId);
    for (const [sessionId, owner] of this.sessions) {
      if (owner !== runId) continue;
      this.sessions.delete(sessionId);
      this.delegations.delete(sessionId);
    }
  }

  bindSession(session: OpenedSession): void {
    const leads = session.agent === CODE_GRAPH_LEAD_AGENT && session.delegationId === undefined;
    const explores = session.agent === CODE_GRAPH_EXPLORE_AGENT && session.delegationId !== undefined;
    if (!leads && !explores) return;
    if (!this.graphs.has(session.runId)) return;
    this.sessions.set(session.sessionId, session.runId);
    if (session.delegationId !== undefined) this.delegations.set(session.sessionId, session.delegationId);
  }

  unbindSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.delegations.delete(sessionId);
  }

  /* The delegation an explore session was opened for; the lead's own sessions have none. */
  delegationOf(sessionId: string): string | undefined {
    return this.delegations.get(sessionId);
  }

  find(sessionId: string): LiveCodeGraph | undefined {
    const runId = this.sessions.get(sessionId);
    return runId === undefined ? undefined : this.graphs.get(runId);
  }

  get size(): number {
    return this.graphs.size;
  }
}
