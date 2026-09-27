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
   covers this SDK's normal request shapes (none of them are long-held — that is what the SSE stream
   in sse.ts is for) while still failing fast enough to be actionable.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

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
  request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  base: string;
  token?: string;
  fetchImpl: typeof fetch;
}

export function createTransport(opts: TransportOptions): Transport {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = opts.token;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";

    /* The default timeout always applies; an explicit caller signal (cancelling an in-flight
       request from the UI, say) is merged in on top rather than replacing it.
     */
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: requestSignal,
      });
    } catch (err) {
      if (signal?.aborted) throw err; /* the caller's own cancellation — propagate as-is */
      if (timeoutSignal.aborted) {
        throw new ApiError(`request to ${base || "(same origin)"} timed out after ${requestTimeoutMs}ms`);
      }
      throw new ApiError(`cannot reach the orchestrator at ${base || "(same origin)"} — is it running?`);
    }

    const text = await res.text();
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
