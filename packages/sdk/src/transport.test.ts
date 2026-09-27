import { test } from "node:test";
import assert from "node:assert/strict";
import { createTransport, ApiError, DEFAULT_REQUEST_TIMEOUT_MS } from "./transport";

/* A fetch stub that never resolves on its own — mirroring a stalled connection (the orchestrator
   process wedged, a dropped TCP connection with no RST, …). It only settles when its `init.signal`
   aborts, rejecting with the signal's abort reason exactly as real fetch/undici do. Without a
   caller-enforced bound this would hang the returned promise forever.
 */
function hangingFetchImpl(): typeof fetch {
  return (async (_url: string, init?: { signal?: AbortSignal }) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; /* no signal at all — truly never settles (not exercised below) */
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as unknown as typeof fetch;
}

test("DEFAULT_REQUEST_TIMEOUT_MS is 15s", () => {
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 15_000);
});

test("a hanging fetch is bounded by the default timeout instead of hanging forever", async () => {
  const t = createTransport({ baseUrl: "http://x", fetchImpl: hangingFetchImpl(), requestTimeoutMs: 5 });
  await assert.rejects(t.request("GET", "/api/v1/queue"), (err: unknown) => {
    assert.ok(err instanceof ApiError, `expected ApiError, got ${err}`);
    assert.match((err as ApiError).message, /timed out/);
    return true;
  });
});

test("an explicit caller AbortSignal aborts a hanging request independently of the timeout", async () => {
  /* A generous timeout that must never be the thing that ends this request — only the caller's
     own signal should.
   */
  const t = createTransport({ baseUrl: "http://x", fetchImpl: hangingFetchImpl(), requestTimeoutMs: 10_000 });
  const ac = new AbortController();
  const pending = t.request("GET", "/api/v1/queue", undefined, ac.signal);
  queueMicrotask(() => ac.abort());
  await assert.rejects(pending);
});

test("a request that resolves before the timeout is unaffected", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ pending: 0, running: null }), { status: 200 })) as unknown as typeof fetch;
  const t = createTransport({ baseUrl: "http://x", fetchImpl, requestTimeoutMs: 10_000 });
  const result = await t.request<{ pending: number }>("GET", "/api/v1/queue");
  assert.equal(result.pending, 0);
});
