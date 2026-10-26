import type { AgentBrowserHandle, AgentBrowserOpenInput } from "../../domain/agent-browser.ts";

export interface AgentBrowserPort {
  /** Resolves undefined when this run is not granted the browser (disabled, another runtime, no saved session to use). */
  open(input: AgentBrowserOpenInput): Promise<AgentBrowserHandle | undefined>;
}
