/*
 * Outbound HTTP setup for Node's fetch (undici). Node fetch does not honor HTTP_PROXY/HTTPS_PROXY/NO_PROXY on its
 * own; EnvHttpProxyAgent does, and is a no-op when none are set.
 *
 * The agent transport (every request to `opencode serve`) has a dispatcher of its own with no headers or body
 * deadline. A prompt is one request held open until the turn answers; the turn's own limit, or the run's deadline,
 * ends it by aborting the prompt on the server, which then answers the request. A transport deadline would be a second
 * time authority that could only end a turn early, under a limit nobody set for that turn.
 *
 * Every other call to the server (a session created or deleted, the agent and provider lists) is short and answers at once, so each
 * carries a bound of its own, set here where the requests are built: a server that accepts the connection and never answers would
 * otherwise hold the run and the sequential queue forever. A hang ends with `AgentRuntimeCallTimeoutError`, naming the call. The
 * event stream is the one other long-lived request: it is bounded until its headers arrive and then runs as long as its caller's signal.
 *
 * That dispatcher is the installed undici's, so the request goes through the installed undici's own fetch: Node's global fetch bundles
 * an undici of its own, and a dispatcher of another version handed to it fails every request before it leaves (`invalid
 * onRequestStart method`). The SDK hands over a Request of Node's own fetch, which the installed fetch does not take as one, so it is
 * sent by its parts (address, method, headers, body, signal).
 */

import { AgentUnavailableError } from "@kernel/domain-error";
import { EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher, type BodyInit as UndiciBodyInit, type Dispatcher, type HeadersInit as UndiciHeadersInit } from "undici";

/* Makes the global fetch proxy-aware, keeping undici's own timeouts. Idempotent. */
export function installHttpDispatcher(): void {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

/* The longest a call to `opencode serve` other than a prompt may take, headers and body together. */
export const NON_PROMPT_CALL_TIMEOUT_MS = 60_000;

/* A call to the agent runtime, other than a prompt, that got no answer within its bound. */
export class AgentRuntimeCallTimeoutError extends AgentUnavailableError {
  constructor(readonly call: string, readonly boundMs: number) {
    super(`the agent runtime did not answer ${call} within ${boundMs}ms`);
    this.name = "AgentRuntimeCallTimeoutError";
  }
}

export interface AgentTransportFetchDeps {
  makeDispatcher(options: { headersTimeout: 0; bodyTimeout: 0 }): unknown;
  fetch(request: Request, init: { dispatcher: unknown; signal: AbortSignal }): Promise<Response>;
}

export interface AgentTransportFetchOptions {
  /* The bound of a call that is not a prompt; absent: NON_PROMPT_CALL_TIMEOUT_MS. */
  nonPromptTimeoutMs?: number;
}

/* The one request held open until a turn answers: its limits are the turn's, the stall watchdog's and the run's deadline. */
function isPrompt(request: Request): boolean {
  return request.method === "POST" && /^\/session\/[^/]+\/message$/.test(new URL(request.url).pathname);
}

function isEventStream(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("text/event-stream");
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
      signal: init.signal,
      redirect: request.redirect,
      dispatcher: init.dispatcher as Dispatcher,
    })) as unknown as Response,
};

/* The fetch the agent transport sends its requests with; the dispatcher is built on the first request. */
export function createAgentTransportFetch(deps: AgentTransportFetchDeps = defaultAgentTransportFetchDeps, options: AgentTransportFetchOptions = {}): (request: Request) => Promise<Response> {
  let dispatcher: unknown;
  const boundMs = options.nonPromptTimeoutMs ?? NON_PROMPT_CALL_TIMEOUT_MS;
  return async (request) => {
    dispatcher ??= deps.makeDispatcher({ headersTimeout: 0, bodyTimeout: 0 });
    const url = new URL(request.url);
    const call = `${request.method} ${url.pathname}`;
    /* A prompt is held to its turn; every other call to the server is held to the bound, merged with the caller's own signal. */
    const bounded = !isPrompt(request);
    const limit = new AbortController();
    const timer = bounded ? setTimeout(() => limit.abort(new AgentRuntimeCallTimeoutError(call, boundMs)), boundMs) : undefined;
    timer?.unref();
    const signal = bounded ? AbortSignal.any([request.signal, limit.signal]) : request.signal;
    try {
      const response = await deps.fetch(request, { dispatcher, signal });
      /* The event stream is open for as long as its caller listens: the bound ends when it has answered. */
      if (timer !== undefined && isEventStream(response)) clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      /* An abort is the caller's own end of the request and stays what it was. */
      if (request.signal.aborted) throw err;
      if (limit.signal.aborted) throw limit.signal.reason;
      /* Any other rejection is a request that never got an answer: fetch says only "fetch failed", and why is in its cause, which every caller would otherwise drop. */
      throw new Error(`the agent runtime at ${url.host} did not answer ${request.method} ${url.pathname}: ${causeChain(err)}`, { cause: err });
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
