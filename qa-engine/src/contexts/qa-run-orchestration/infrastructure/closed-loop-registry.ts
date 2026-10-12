/*
 * Which live run_spec loop a generator session belongs to. The orchestrator opens the generator's session and learns its id
 * only then, so the id is bound to the run's capability at that moment (the agent transport reports every session it opens
 * for a run); the tools endpoint then finds the loop by the session id the tool reports. A session no loop owns, or one of
 * another agent, finds nothing. A run has one loop of its own, for its generator, and one more for each flow of a plan, for the
 * sidekick that authors the flow: each with its own capability, so the calls, the writes to DEV and the namespaces of a flow are
 * the flow's own.
 */

import { RUN_SPEC_AGENT, RUN_SPEC_FLOW_AGENT, type RunSpecCapability } from "@contexts/test-execution/domain/run-spec-capability.ts";
import type { RunSpecRequest, RunSpecResponse } from "@contexts/test-execution/application/run-spec.use-case.ts";

export interface LiveLoop {
  runId: string;
  /* Set on the loop of one flow of a plan: its sidekick's sessions find this loop and the run's generator does not. Absent on the run's own loop. */
  delegationId?: string;
  capability: RunSpecCapability;
  /* Executes one call inside the run's own scope (its sandbox, its secrets), whatever request triggered it. */
  call(request: RunSpecRequest): Promise<RunSpecResponse>;
  /* Stops the call this session left running, if any: nobody is reading its answer any more. */
  cancel?(sessionId: string): void;
}

export interface OpenedSession {
  sessionId: string;
  runId: string;
  /* The OpenCode agent name of the session. */
  agent: string;
  /* The flow of a plan the session was opened for, when it was. */
  delegationId?: string;
}

const keyOf = (runId: string, delegationId?: string): string => (delegationId === undefined ? runId : `${runId}\u0000${delegationId}`);

export class ClosedLoopRegistry {
  /* Each loop by its key: the run's own by the run id, a flow's by the run id and its delegation id. */
  private readonly loops = new Map<string, LiveLoop>();
  /* Each bound session by the key of the loop it holds. */
  private readonly sessions = new Map<string, string>();

  register(loop: LiveLoop): void {
    const key = keyOf(loop.runId, loop.delegationId);
    if (this.loops.has(key)) {
      throw new Error(loop.delegationId === undefined ? `a run_spec loop is already open for run ${loop.runId}` : `a run_spec loop is already open for flow ${loop.delegationId} of run ${loop.runId}`);
    }
    this.loops.set(key, loop);
  }

  /* The run ends: its own loop and every flow's go, with the sessions that held them. */
  unregister(runId: string): void {
    for (const [key, loop] of this.loops) if (loop.runId === runId) this.loops.delete(key);
    for (const [sessionId, key] of this.sessions) if (!this.loops.has(key)) this.sessions.delete(sessionId);
  }

  /* One flow ends: its loop goes, with the sessions that held it. */
  unregisterFlow(runId: string, delegationId: string): void {
    const key = keyOf(runId, delegationId);
    this.loops.delete(key);
    for (const [sessionId, held] of this.sessions) if (held === key) this.sessions.delete(sessionId);
  }

  /*
   * Gives a session the right to call: the generator's session of a run, the run's own loop; the session of a sidekick opened for
   * a flow, that flow's loop. Nothing else is bound: not a sidekick's session with no flow, not a flow that has no loop, not the
   * generator's session when it names a flow, and no other agent's session.
   */
  bindSession(session: OpenedSession): void {
    let key: string;
    if (session.agent === RUN_SPEC_AGENT && session.delegationId === undefined) key = keyOf(session.runId);
    else if (session.agent === RUN_SPEC_FLOW_AGENT && session.delegationId !== undefined) key = keyOf(session.runId, session.delegationId);
    else return;
    const loop = this.loops.get(key);
    if (!loop) return;
    loop.capability.bindSession(session.sessionId);
    this.sessions.set(session.sessionId, key);
  }

  unbindSession(sessionId: string): void {
    const key = this.sessions.get(sessionId);
    if (key === undefined) return;
    this.sessions.delete(sessionId);
    const loop = this.loops.get(key);
    loop?.capability.unbindSession(sessionId);
    loop?.cancel?.(sessionId);
  }

  find(sessionId: string): LiveLoop | undefined {
    const key = this.sessions.get(sessionId);
    return key === undefined ? undefined : this.loops.get(key);
  }

  get size(): number {
    return this.loops.size;
  }
}
