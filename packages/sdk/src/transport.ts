/* The hand-written half of the SDK: a thin fetch wrapper that every TS client shares.
   It owns base URL, Bearer auth, JSON encode/decode and error normalization — the glue
   that would otherwise be re-implemented (and drift) in each client. `fetchImpl` is
   injectable so the transport is unit-testable without a network.
 */

export class ApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/* Every request must be bounded — a stalled orchestrator connection (process wedged, a dropped TCP
   connection with no RST) must never leave a caller awaiting a promise forever. 15s comfortably
   covers this SDK's ordinary request shapes (long-held ones are the SSE stream in sse.ts and the
   assistant calls, which carry their own bound) while still failing fast enough to be actionable.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/* The run/help assistant answers with a model turn, which routinely takes longer than an ordinary
   read — the same bound the Go TUI gives its chat. */
export const ASSISTANT_REQUEST_TIMEOUT_MS = 60_000;

export interface RequestOptions {
  /* Cancels the request (a UI abandoning it, say); merged with the timeout, never replacing it. */
  signal?: AbortSignal;
  /* This call's bound instead of the transport's default — for requests known to be long. */
  timeoutMs?: number;
}

export interface TransportOptions {
  /* "" for a same-origin client (the dashboard served at /app); a full origin otherwise. */
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  /* Overrides DEFAULT_REQUEST_TIMEOUT_MS — present so tests can bound a hanging fetch stub without
     waiting out the real default.
   */
  requestTimeoutMs?: number;
}

export interface Transport {
  request<T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  base: string;
  token?: string;
  fetchImpl: typeof fetch;
}

export function createTransport(opts: TransportOptions): Transport {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = opts.token;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";

    /* A timeout always applies — this call's own when given, the transport's otherwise; an explicit
       caller signal (cancelling an in-flight request from the UI, say) is merged in on top rather
       than replacing it. It bounds the WHOLE exchange, the body read included: a server that sends
       headers and then stalls must fail the same way as one that never answers.
     */
    const timeoutMs = opts.timeoutMs ?? requestTimeoutMs;
    const signal = opts.signal;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
    const where = base || "(same origin)";

    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: requestSignal,
      });
    } catch (err) {
      if (signal?.aborted) throw err; /* the caller's own cancellation — propagate as-is */
      if (timeoutSignal.aborted) throw new ApiError(`request to ${where} timed out after ${timeoutMs}ms`);
      throw new ApiError(`cannot reach the orchestrator at ${where} — is it running?`);
    }
    try {
      text = await res.text();
    } catch (err) {
      if (signal?.aborted) throw err;
      if (timeoutSignal.aborted) throw new ApiError(`request to ${where} timed out after ${timeoutMs}ms`, res.status);
      throw new ApiError(`the connection to ${where} dropped while reading the response`, res.status);
    }

    if (!res.ok) {
      if (res.status === 401) throw new ApiError("unauthorized — check the API token", 401);
      let message = `request failed (HTTP ${res.status})`;
      try {
        const j = JSON.parse(text) as { error?: string; message?: string };
        message = j.error ?? j.message ?? message;
      } catch {
        /* non-JSON error body — keep the generic message */
      }
      throw new ApiError(message, res.status);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  return { request, base, token, fetchImpl };
}
