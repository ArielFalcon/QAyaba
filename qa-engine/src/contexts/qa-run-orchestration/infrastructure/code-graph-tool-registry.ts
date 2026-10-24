/*
 * Which live code-graph right a session belongs to. The orchestrator learns an agent session's id only when the session opens
 * (the agent transport reports every session it opens for a run), so the right is bound to the id at that moment; the tools
 * endpoint then finds the run's graph by the session id the tool reports. Only the lead's own sessions are bound: the generator
 * role's sessions that name no flow (the plan, its review, the lead's own generation). A sidekick, the generator's session for a
 * flow and every other role find nothing.
 */

import { CODE_GRAPH_AGENT } from "@kernel/code-graph-tools.ts";
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

  register(graph: LiveCodeGraph): void {
    if (this.graphs.has(graph.runId)) throw new Error(`a code graph is already granted for run ${graph.runId}`);
    this.graphs.set(graph.runId, graph);
  }

  unregister(runId: string): void {
    this.graphs.delete(runId);
    for (const [sessionId, owner] of this.sessions) if (owner === runId) this.sessions.delete(sessionId);
  }

  bindSession(session: OpenedSession): void {
    if (session.agent !== CODE_GRAPH_AGENT || session.delegationId !== undefined) return;
    if (!this.graphs.has(session.runId)) return;
    this.sessions.set(session.sessionId, session.runId);
  }

  unbindSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  find(sessionId: string): LiveCodeGraph | undefined {
    const runId = this.sessions.get(sessionId);
    return runId === undefined ? undefined : this.graphs.get(runId);
  }

  get size(): number {
    return this.graphs.size;
  }
}
