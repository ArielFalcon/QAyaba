/*
 * Which live authenticated-browser right a session belongs to. The orchestrator learns an agent session's id only when the
 * session opens (the agent transport reports every session it opens for a run), so the right is bound to the id at that
 * moment; the tools endpoint then finds the run's browser by the session id the tool reports. A session no run owns, or one
 * of a role that does not author, finds nothing. Sessions of the same run share the run's browser, each with a page of its own.
 */

import { AGENT_BROWSER_AGENTS, type AgentBrowserCapability } from "@contexts/test-execution/domain/agent-browser-capability.ts";
import type { AgentBrowserRequest, AgentBrowserResponse } from "@contexts/test-execution/application/agent-browser.use-case.ts";
import type { OpenedSession } from "./closed-loop-registry.ts";

export interface LiveBrowser {
  runId: string;
  capability: AgentBrowserCapability;
  /* Serves one call inside the run's own scope (its sandbox, its secrets), whatever request brought it. */
  call(request: AgentBrowserRequest): Promise<AgentBrowserResponse>;
  /* The session ended: stops the call it left running and closes its page. */
  endSession(sessionId: string): void;
  /* Revokes the right and stops the browser. Never throws. */
  close(): Promise<void>;
}

export class AgentBrowserRegistry {
  private readonly browsers = new Map<string, LiveBrowser>();
  private readonly sessions = new Map<string, string>();

  register(browser: LiveBrowser): void {
    if (this.browsers.has(browser.runId)) throw new Error(`an agent browser is already open for run ${browser.runId}`);
    this.browsers.set(browser.runId, browser);
  }

  unregister(runId: string): void {
    this.browsers.delete(runId);
    for (const [sessionId, owner] of this.sessions) if (owner === runId) this.sessions.delete(sessionId);
  }

  /* Gives an authoring role's session of a run the right to call, when the run has a browser. Any other role's session, and a session of a run without one, gets nothing. */
  bindSession(session: OpenedSession): void {
    if (!AGENT_BROWSER_AGENTS.has(session.agent)) return;
    const browser = this.browsers.get(session.runId);
    if (!browser) return;
    browser.capability.bindSession(session.sessionId, session.delegationId);
    this.sessions.set(session.sessionId, session.runId);
  }

  unbindSession(sessionId: string): void {
    const runId = this.sessions.get(sessionId);
    if (runId === undefined) return;
    this.sessions.delete(sessionId);
    const browser = this.browsers.get(runId);
    browser?.capability.unbindSession(sessionId);
    browser?.endSession(sessionId);
  }

  find(sessionId: string): LiveBrowser | undefined {
    const runId = this.sessions.get(sessionId);
    return runId === undefined ? undefined : this.browsers.get(runId);
  }

  /* Closes every browser still open. A run closes its own when it ends, however it ends; this is for the ones a crash or a restart left (boot recovery, and the start of the next run). */
  async sweepAll(): Promise<number> {
    const open = [...this.browsers.values()];
    for (const browser of open) {
      this.unregister(browser.runId);
      await browser.close();
    }
    return open.length;
  }

  get size(): number {
    return this.browsers.size;
  }
}
