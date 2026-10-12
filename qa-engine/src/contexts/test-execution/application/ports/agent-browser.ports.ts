import type { GuardReason } from "../../domain/agent-browser-route-guard.ts";

/* What a tool call asks of the browser. A ref is one the last snapshot of the same session gave. */
export type BrowserAction =
  | { kind: "navigate"; url: string }
  | { kind: "snapshot" }
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string; submit: boolean };

export interface BlockedRequest {
  reason: GuardReason;
  /* Method and address without query or credentials. */
  detail: string;
}

/* What the page looks like after a call. */
export interface PageState {
  url: string;
  title: string;
  /* The accessibility tree, with refs. */
  snapshot: string;
  /* The status of the main document when the call loaded one. */
  documentStatus?: number;
  passwordFieldVisible: boolean;
  /* The path the call asked for: a navigation's target, otherwise the page the session was on. */
  requestedPath: string;
  /* Requests the guard refused during the call. */
  blocked: BlockedRequest[];
  /* Things the agent should know that are not in the tree (a dialog dismissed, a tab closed). */
  notes: string[];
}

export interface BrowserCallOptions {
  /* Aborts when the call's time is up or its session ended. */
  signal: AbortSignal;
  timeoutMs: number;
}

/* The browser could not do what was asked for a reason the agent can act on (a ref that is gone, an element that is not there). Anything else the host throws is a fault and is not shown. */
export class BrowserActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserActionError";
  }
}

/* The orchestrator's browser, in the run's session, behind the route guard. One page per agent session. */
export interface AgentBrowserHostPort {
  perform(sessionId: string, action: BrowserAction, options: BrowserCallOptions): Promise<PageState>;
  /* Closes the page of a session that ended. Optional: a host with nothing per session has nothing to close. */
  release?(sessionId: string): Promise<void>;
  /* Drops the browser's state (cookies, pages) so that the next call starts from the session as it is saved now. */
  reset(): Promise<void>;
  /* Stops the browser and forgets everything it held. Idempotent; never throws. */
  close(): Promise<void>;
}
