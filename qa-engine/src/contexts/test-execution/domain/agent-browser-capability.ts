/*
 * The right a run grants its authoring agents to drive an authenticated browser (the `authbrowser_*` tools). Pure:
 * counters, expiry and the telemetry of what happened, with no clock of its own, no browser and no file. A capability belongs
 * to one run, is bound to the sessions the orchestrator saw open for an authoring role, and is revoked when the run ends.
 * Every limit is a count the orchestrator keeps, so a model cannot talk its way past one.
 */

import { CODE_GRAPH_EXPLORE_AGENT } from "@kernel/code-graph-tools.ts";
import { DEFAULT_AGENT_BROWSER_LIMITS, type AgentBrowserGateSignal, type AgentBrowserLimits } from "@kernel/agent-browser.ts";

/* The only agents whose sessions may hold the capability: the roles that author tests and the explore role. Every other role is denied the tools in agents/opencode.json, and refused here. */
export const AGENT_BROWSER_AGENTS: ReadonlySet<string> = new Set(["qa-generator", "qa-sidekick", CODE_GRAPH_EXPLORE_AGENT]);

/* The holders whose sessions never write to DEV, whatever the app allows: the route guard ignores the app's allowMutating entries for them. */
export const AGENT_BROWSER_READ_ONLY_AGENTS: ReadonlySet<string> = new Set([CODE_GRAPH_EXPLORE_AGENT]);

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
  /* The calls each flow of a plan may make, and how many it has made; the session each flow's sidekick opened belongs to. */
  private readonly shares = new Map<string, { share: number; used: number }>();
  private readonly flowOfSession = new Map<string, string>();
  private readonly readOnlySessions = new Set<string>();
  /* The pages each flow's sessions were shown, by path: what the orchestrator saw the browser read, never what an agent says it read. */
  private readonly readPaths = new Map<string, Set<string>>();

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

  /* Gives a flow of a plan the calls it may make out of the run's: the sessions bound for it spend from this and from the run's alike. */
  setShare(delegationId: string, calls: number): void {
    this.shares.set(delegationId, { share: Math.max(0, Math.floor(calls)), used: 0 });
  }

  bindSession(sessionId: string, delegationId?: string, agent?: string): void {
    this.sessions.add(sessionId);
    if (delegationId !== undefined) this.flowOfSession.set(sessionId, delegationId);
    if (agent !== undefined && AGENT_BROWSER_READ_ONLY_AGENTS.has(agent)) this.readOnlySessions.add(sessionId);
  }

  unbindSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.flowOfSession.delete(sessionId);
    this.readOnlySessions.delete(sessionId);
  }

  /* Notes that the session's browser showed the page at this path. A session bound to no flow leaves no ledger. */
  recordRead(sessionId: string, path: string): void {
    const flow = this.flowOfSession.get(sessionId);
    if (flow === undefined) return;
    const paths = this.readPaths.get(flow) ?? new Set<string>();
    paths.add(path);
    this.readPaths.set(flow, paths);
  }

  /* The paths the flow's sessions were shown, in the order they were first read. */
  readsOf(delegationId: string): readonly string[] {
    return [...(this.readPaths.get(delegationId) ?? [])];
  }

  /* Whether the session's role never writes to DEV: its requests are judged without the app's allowMutating entries. */
  isReadOnly(sessionId: string): boolean {
    return this.readOnlySessions.has(sessionId);
  }

  revoke(): void {
    this.revoked = true;
  }

  authorize(sessionId: string, agent: string): AgentBrowserRefusal | undefined {
    if (this.revoked) return refuse(AGENT_BROWSER_REFUSAL.REVOKED, "the authenticated browser is no longer available: the run it belonged to has ended");
    if (this.init.now() >= this.init.expiresAtMs) return refuse(AGENT_BROWSER_REFUSAL.EXPIRED, "the authenticated browser is no longer available: its time has run out");
    if (!this.sessions.has(sessionId)) return refuse(AGENT_BROWSER_REFUSAL.UNKNOWN_SESSION, "the authenticated browser is not available to this session");
    if (!AGENT_BROWSER_AGENTS.has(agent)) return refuse(AGENT_BROWSER_REFUSAL.WRONG_AGENT, "the authenticated browser is available to the roles that author tests and to the explore role only");
    return undefined;
  }

  callsLeft(): number {
    return Math.max(0, this.limits.maxCalls - this.calls_);
  }

  /* Takes one call from the budget, or says why there is none. A session bound for a flow also spends from the flow's share, and a flow with no share has no calls. */
  reserve(sessionId?: string): { ok: true; callNumber: number } | AgentBrowserRefusal {
    if (this.revoked) return refuse(AGENT_BROWSER_REFUSAL.REVOKED, "the authenticated browser is no longer available: the run it belonged to has ended");
    if (this.calls_ >= this.limits.maxCalls) return refuse(AGENT_BROWSER_REFUSAL.NO_CALLS, `the ${this.limits.maxCalls} authenticated browser calls of this run are spent`);
    const flow = sessionId === undefined ? undefined : this.flowOfSession.get(sessionId);
    const share = flow === undefined ? undefined : (this.shares.get(flow) ?? { share: 0, used: 0 });
    if (share && share.used >= share.share) return refuse(AGENT_BROWSER_REFUSAL.NO_CALLS, `the ${share.share} authenticated browser calls of this flow are spent`);
    if (share) share.used += 1;
    this.calls_ += 1;
    return { ok: true, callNumber: this.calls_ };
  }

  /* Gives back a call `reserve` took when it never began (it timed out waiting for the account, or its session ended first): nothing ran, so the run's calls and its flow's share are not spent. */
  refund(sessionId?: string): void {
    const flow = sessionId === undefined ? undefined : this.flowOfSession.get(sessionId);
    const share = flow === undefined ? undefined : this.shares.get(flow);
    if (share && share.used > 0) share.used -= 1;
    if (this.calls_ > 0) this.calls_ -= 1;
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
