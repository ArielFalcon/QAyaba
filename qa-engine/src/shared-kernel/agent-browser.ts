/* The authenticated agent browser as the layers around it share it: what an app's config lets it do, the limits one run grants, and what the run records about its use. */

/* The tools an authoring role is given, by the name OpenCode shows the model (the file agents/tool/authbrowser.ts and its exports). */
export const AGENT_BROWSER_TOOLS = ["authbrowser_navigate", "authbrowser_snapshot", "authbrowser_click", "authbrowser_type"] as const;

/* Pages the run's browser holds at once, one per session that uses it: the lead and the sidekicks of a plan. A plan is never asked to run more flows at once than this. */
export const MAX_SESSION_PAGES = 4;

export interface AgentBrowserSetting {
  /* Absolute paths (`*` within a segment, `**` across segments) the browser never reaches, whatever the method. */
  denyRoutes: readonly string[];
  /* `[METHOD ]/path` entries: the only requests that write which the browser lets through. */
  allowMutating: readonly string[];
}

export interface AgentBrowserLimits {
  /* Tool calls in one run, across every session that holds the right. */
  maxCalls: number;
  /* The longest one call may take, its own wait for the account excluded. */
  perCallMs: number;
  /* How long a call waits for the test account before it answers that DEV is busy. */
  leaseWaitMs: number;
}

export const DEFAULT_AGENT_BROWSER_LIMITS: AgentBrowserLimits = { maxCalls: 150, perCallMs: 30_000, leaseWaitMs: 15_000 };

/* What a run records: how often the agent used the browser, what the guard stopped and how many times the session was lost. Persist-only. */
export interface AgentBrowserGateSignal {
  calls: number;
  /* Requests the route guard refused (a write, a denied route, an undeclared origin). */
  blocks: number;
  /* Calls that found the session gone. */
  invalidations: number;
  /* Of those, how many the auth port signed in again. */
  renewals: number;
}
