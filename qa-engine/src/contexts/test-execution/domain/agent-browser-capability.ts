/*
 * The right a run grants its authoring agents to drive an authenticated browser (the `authbrowser_*` tools). Pure:
 * counters, expiry and the telemetry of what happened, with no clock of its own, no browser and no file. A capability belongs
 * to one run, is bound to the sessions the orchestrator saw open for an authoring role, and is revoked when the run ends.
 * Every limit is a count the orchestrator keeps, so a model cannot talk its way past one.
 */

import { DEFAULT_AGENT_BROWSER_LIMITS, type AgentBrowserGateSignal, type AgentBrowserLimits } from "@kernel/agent-browser.ts";

/* The only agents whose sessions may hold the capability: the roles that author tests. Every other role is denied the tools in agents/opencode.json, and refused here. */
export const AGENT_BROWSER_AGENTS: ReadonlySet<string> = new Set(["qa-generator", "qa-sidekick"]);

/* A session that finds the login page again after this many renewals is not going to be helped by another. */
export const MAX_RENEWALS = 2;

export const AGENT_BROWSER_REFUSAL = {
  REVOKED: "revoked",
  EXPIRED: "expired",
  UNKNOWN_SESSION: "unknown-session",
  WRONG_AGENT: "wrong-agent",
  NO_CALLS: "no-calls",
  INVALID_REQUEST: "invalid-request",
  BLOCKED: "blocked",
  BUSY: "busy",
  SESSION_INVALIDATED: "session-invalidated",
  FAILED: "failed",
} as const;

export type AgentBrowserRefusalCode = (typeof AGENT_BROWSER_REFUSAL)[keyof typeof AGENT_BROWSER_REFUSAL];

export interface AgentBrowserRefusal {
  ok: false;
  code: AgentBrowserRefusalCode;
  message: string;
}

export interface AgentBrowserCapabilityInit {
  runId: string;
  limits?: AgentBrowserLimits;
  expiresAtMs: number;
  now: () => number;
}

function refuse(code: AgentBrowserRefusalCode, message: string): AgentBrowserRefusal {
  return { ok: false, code, message };
}

export class AgentBrowserCapability {
  private readonly sessions = new Set<string>();
  private revoked = false;
  private calls_ = 0;
  private blocks_ = 0;
  private invalidations_ = 0;
  private renewals_ = 0;
  private failedRenewals = 0;

  constructor(private readonly init: AgentBrowserCapabilityInit) {}

  get runId(): string {
    return this.init.runId;
  }

  get limits(): AgentBrowserLimits {
    return this.init.limits ?? DEFAULT_AGENT_BROWSER_LIMITS;
  }

  get signal(): AgentBrowserGateSignal {
    return { calls: this.calls_, blocks: this.blocks_, invalidations: this.invalidations_, renewals: this.renewals_ };
  }

  bindSession(sessionId: string): void {
    this.sessions.add(sessionId);
  }

  unbindSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  revoke(): void {
    this.revoked = true;
  }

  authorize(sessionId: string, agent: string): AgentBrowserRefusal | undefined {
    if (this.revoked) return refuse(AGENT_BROWSER_REFUSAL.REVOKED, "the authenticated browser is no longer available: the run it belonged to has ended");
    if (this.init.now() >= this.init.expiresAtMs) return refuse(AGENT_BROWSER_REFUSAL.EXPIRED, "the authenticated browser is no longer available: its time has run out");
    if (!this.sessions.has(sessionId)) return refuse(AGENT_BROWSER_REFUSAL.UNKNOWN_SESSION, "the authenticated browser is not available to this session");
    if (!AGENT_BROWSER_AGENTS.has(agent)) return refuse(AGENT_BROWSER_REFUSAL.WRONG_AGENT, "the authenticated browser is available to the roles that author tests only");
    return undefined;
  }

  callsLeft(): number {
    return Math.max(0, this.limits.maxCalls - this.calls_);
  }

  /* Takes one call from the budget, or says why there is none. */
  reserve(): { ok: true; callNumber: number } | AgentBrowserRefusal {
    if (this.revoked) return refuse(AGENT_BROWSER_REFUSAL.REVOKED, "the authenticated browser is no longer available: the run it belonged to has ended");
    if (this.calls_ >= this.limits.maxCalls) return refuse(AGENT_BROWSER_REFUSAL.NO_CALLS, `the ${this.limits.maxCalls} authenticated browser calls of this run are spent`);
    this.calls_ += 1;
    return { ok: true, callNumber: this.calls_ };
  }

  recordBlocks(count: number): void {
    this.blocks_ += count;
  }

  /* Whether another sign-in may be attempted. */
  canRenew(): boolean {
    return this.failedRenewals + this.renewals_ < MAX_RENEWALS;
  }

  recordInvalidation(renewed: boolean | undefined): void {
    this.invalidations_ += 1;
    if (renewed === true) this.renewals_ += 1;
    if (renewed === false) this.failedRenewals += 1;
  }
}
