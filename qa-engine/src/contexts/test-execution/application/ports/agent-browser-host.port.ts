import type { BrowserAction, BrowserCallOptions, PageState } from "../../domain/agent-browser-host.ts";

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
