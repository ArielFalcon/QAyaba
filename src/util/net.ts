/*
 * Outbound HTTP setup for Node's fetch (undici). Node fetch does not honor HTTP_PROXY/HTTPS_PROXY/NO_PROXY on its
 * own; EnvHttpProxyAgent does, and is a no-op when none are set.
 *
 * The agent transport (every request to `opencode serve`) has a dispatcher of its own with no headers or body
 * deadline. A prompt is one request held open until the turn answers; the turn's own limit, or the run's deadline,
 * ends it by aborting the prompt on the server, which then answers the request. A transport deadline would be a second
 * time authority that could only end a turn early, under a limit nobody set for that turn.
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/* Makes the global fetch proxy-aware, keeping undici's own timeouts. Idempotent. */
export function installHttpDispatcher(): void {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

export interface AgentTransportFetchDeps {
  makeDispatcher(options: { headersTimeout: 0; bodyTimeout: 0 }): unknown;
  fetch(request: Request, init: { dispatcher: unknown }): Promise<Response>;
}

const defaultAgentTransportFetchDeps: AgentTransportFetchDeps = {
  makeDispatcher: (options) => new EnvHttpProxyAgent(options),
  fetch: (request, init) => fetch(request, init as RequestInit),
};

/* The fetch the agent transport sends its requests with; the dispatcher is built on the first request. */
export function createAgentTransportFetch(deps: AgentTransportFetchDeps = defaultAgentTransportFetchDeps): (request: Request) => Promise<Response> {
  let dispatcher: unknown;
  return (request) => {
    dispatcher ??= deps.makeDispatcher({ headersTimeout: 0, bodyTimeout: 0 });
    return deps.fetch(request, { dispatcher });
  };
}

export const agentTransportFetch = createAgentTransportFetch();
