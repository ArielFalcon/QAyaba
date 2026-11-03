/* The authenticated agent browser as the layers around it share it: what an app's config lets it do, the limits one run grants, and what the run records about its use. */

/* The tools an authoring role is given, by the name OpenCode shows the model (the file agents/tool/authbrowser.ts and its exports). */
export const AGENT_BROWSER_TOOLS = ["authbrowser_navigate", "authbrowser_snapshot", "authbrowser_click", "authbrowser_type"] as const;

/* Pages the run's browser holds at once, one per session that uses it: the lead and the sidekicks of a plan. A plan is never asked to run more flows at once than this. */
export const MAX_SESSION_PAGES = 4;

export interface AgentBrowserLimits {
  /* Tool calls in one run of the sessions bound to no share (the run's own author). A flow of a plan spends only its own share, so the run's total for its flows is the sum of their grants. */
  maxCalls: number;
  /* The longest one call may take, its own wait for the account excluded. */
  perCallMs: number;
  /* How long a call waits for the test account before it answers that DEV is busy. */
  leaseWaitMs: number;
}

export const DEFAULT_AGENT_BROWSER_LIMITS: AgentBrowserLimits = { maxCalls: 150, perCallMs: 30_000, leaseWaitMs: 15_000 };

/* Why the browser refused a call, as a closed set: the capability produces it, the tool endpoint maps it to a status and the run's own outcome classifier reads it. */
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

/*
 * What a caller that reads the browser's answer needs to know about it, read from the answer's own fields: the call's
 * outcome, the refusal code when it had one, the page it landed on and that page's document status. The tool answers
 * JSON, so a reader that has the answer needs no scan of its text.
 */
export interface AgentBrowserAnswerFacts {
  ok: boolean;
  code?: AgentBrowserRefusalCode;
  url?: string;
  documentStatus?: number;
}

/* The codes an answer may carry: a value outside this closed set names no refusal. */
const REFUSAL_CODES: ReadonlySet<string> = new Set(Object.values(AGENT_BROWSER_REFUSAL));

/* The facts of an answer the browser produced, or undefined when the value is not that answer (another tool's, an answer cut short, or one that never parsed). Never throws. */
export function readAgentBrowserAnswer(value: unknown): AgentBrowserAnswerFacts | undefined {
  let body: unknown = value;
  if (typeof value === "string") {
    if (value === "" || value.charAt(0) !== "{") return undefined;
    try {
      body = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (typeof body !== "object" || body === null) return undefined;
  const answer = body as { ok?: unknown; code?: unknown; page?: unknown };
  if (typeof answer.ok !== "boolean") return undefined;
  const page = typeof answer.page === "object" && answer.page !== null ? (answer.page as { url?: unknown; status?: unknown }) : undefined;
  const code = typeof answer.code === "string" && REFUSAL_CODES.has(answer.code) ? (answer.code as AgentBrowserRefusalCode) : undefined;
  return {
    ok: answer.ok,
    ...(code !== undefined ? { code } : {}),
    ...(typeof page?.url === "string" ? { url: page.url } : {}),
    ...(typeof page?.status === "number" ? { documentStatus: page.status } : {}),
  };
}

/* What a run records: how often the agent used the browser, what the guard stopped and how many times the session was lost. Persist-only. */
export interface AgentBrowserGateSignal {
  calls: number;
  /* Requests the route guard refused (a write, a denied route, an undeclared origin). */
  blocks: number;
  /* Calls that found the session gone. */
  invalidations: number;
  /* Of those, how many the auth port signed in again. */
  renewals: number;
  /* The calls the run's shares (flows of a plan) were granted, together: the derived total. Absent when none was granted. */
  granted?: number;
}
