/*
 * Outbound HTTP setup for Node's fetch (undici). Node fetch does not honor HTTP_PROXY/HTTPS_PROXY/NO_PROXY on its
 * own; EnvHttpProxyAgent does, and is a no-op when none are set.
 *
 * The agent transport (every request to `opencode serve`) has a dispatcher of its own with no headers or body
 * deadline. A prompt is one request held open until the turn answers; the turn's own limit, or the run's deadline,
 * ends it by aborting the prompt on the server, which then answers the request. A transport deadline would be a second
 * time authority that could only end a turn early, under a limit nobody set for that turn.
 *
 * That dispatcher is the installed undici's, so the request goes through the installed undici's own fetch: Node's global fetch bundles
 * an undici of its own, and a dispatcher of another version handed to it fails every request before it leaves (`invalid
 * onRequestStart method`). The SDK hands over a Request of Node's own fetch, which the installed fetch does not take as one, so it is
 * sent by its parts (address, method, headers, body, signal).
 */

import { EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher, type BodyInit as UndiciBodyInit, type Dispatcher, type HeadersInit as UndiciHeadersInit } from "undici";

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
  fetch: async (request, init) =>
    (await undiciFetch(request.url, {
      method: request.method,
      /* Node's own Headers and stream are the same web standard objects the installed undici reads; only their declared types differ. */
      headers: request.headers as unknown as UndiciHeadersInit,
      body: (request.body ?? undefined) as unknown as UndiciBodyInit | undefined,
      ...(request.body !== null ? { duplex: "half" as const } : {}),
      signal: request.signal,
      redirect: request.redirect,
      dispatcher: init.dispatcher as Dispatcher,
    })) as unknown as Response,
};

/* The fetch the agent transport sends its requests with; the dispatcher is built on the first request. */
export function createAgentTransportFetch(deps: AgentTransportFetchDeps = defaultAgentTransportFetchDeps): (request: Request) => Promise<Response> {
  let dispatcher: unknown;
  return async (request) => {
    dispatcher ??= deps.makeDispatcher({ headersTimeout: 0, bodyTimeout: 0 });
    try {
      return await deps.fetch(request, { dispatcher });
    } catch (err) {
      /* An abort is the caller's own end of the request and stays what it was. Any other rejection is a request that never got an answer: fetch says only "fetch failed", and why is in its cause, which every caller would otherwise drop. */
      if (request.signal.aborted) throw err;
      throw new Error(`the agent runtime at ${new URL(request.url).host} did not answer ${request.method} ${new URL(request.url).pathname}: ${causeChain(err)}`, { cause: err });
    }
  };
}

/* An error's message and the code and message of each cause under it. */
export function causeChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth++) {
    const code = typeof current === "object" && "code" in current && typeof (current as { code?: unknown }).code === "string" ? `${(current as { code: string }).code} ` : "";
    parts.push(`${code}${current instanceof Error ? current.message : String(current)}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(": ");
}

export const agentTransportFetch = createAgentTransportFetch();
