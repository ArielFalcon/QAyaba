/*
 * Which live run_spec loop a generator session belongs to. The orchestrator opens the generator's session and learns its id
 * only then, so the id is bound to the run's capability at that moment (the agent transport reports every session it opens
 * for a run); the tools endpoint then finds the loop by the session id the tool reports. A session no loop owns, or one of
 * another agent, finds nothing. One loop per run, because the queue runs one run at a time.
 */

import { RUN_SPEC_AGENT, type RunSpecCapability } from "@contexts/test-execution/domain/run-spec-capability.ts";
import type { RunSpecRequest, RunSpecResponse } from "@contexts/test-execution/application/run-spec.use-case.ts";

export interface LiveLoop {
  runId: string;
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
}

export class ClosedLoopRegistry {
  private readonly loops = new Map<string, LiveLoop>();
  private readonly sessions = new Map<string, string>();

  register(loop: LiveLoop): void {
    if (this.loops.has(loop.runId)) throw new Error(`a run_spec loop is already open for run ${loop.runId}`);
    this.loops.set(loop.runId, loop);
  }

  unregister(runId: string): void {
    this.loops.delete(runId);
    for (const [sessionId, owner] of this.sessions) if (owner === runId) this.sessions.delete(sessionId);
  }

  /* Gives the generator's session of a run the right to call, when the run has a loop. Any other agent's session, and a session of a run without a loop, gets nothing. */
  bindSession(session: OpenedSession): void {
    if (session.agent !== RUN_SPEC_AGENT) return;
    const loop = this.loops.get(session.runId);
    if (!loop) return;
    loop.capability.bindSession(session.sessionId);
    this.sessions.set(session.sessionId, session.runId);
  }

  unbindSession(sessionId: string): void {
    const runId = this.sessions.get(sessionId);
    if (runId === undefined) return;
    this.sessions.delete(sessionId);
    const loop = this.loops.get(runId);
    loop?.capability.unbindSession(sessionId);
    loop?.cancel?.(sessionId);
  }

  find(sessionId: string): LiveLoop | undefined {
    const runId = this.sessions.get(sessionId);
    return runId === undefined ? undefined : this.loops.get(runId);
  }

  get size(): number {
    return this.loops.size;
  }
}
