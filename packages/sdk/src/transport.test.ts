import { test } from "node:test";
import assert from "node:assert/strict";
import { createTransport, ApiError } from "./transport";
import { createClient } from "./client";

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
  const pending = t.request("GET", "/api/v1/queue", undefined, { signal: ac.signal });
  queueMicrotask(() => ac.abort());
  await assert.rejects(pending);
});

test("an AbortSignal passed as the fourth argument, as earlier SDK versions took it, still cancels the request", async () => {
  const t = createTransport({ baseUrl: "http://x", fetchImpl: hangingFetchImpl(), requestTimeoutMs: 200 });
  const ac = new AbortController();
  const pending = t.request("GET", "/api/v1/queue", undefined, ac.signal);
  queueMicrotask(() => ac.abort());
  await assert.rejects(pending, (err: unknown) => {
    assert.ok(!(err instanceof ApiError), `the caller's cancellation must propagate as-is, got ${String(err)}`);
    assert.equal((err as Error).name, "AbortError");
    return true;
  });
});

/* An abort signal from a polyfill or another realm: the AbortSignal shape, not the native class. */
function foreignAbortController(): { signal: AbortSignal; abort(reason: Error): void } {
  const listeners: (() => void)[] = [];
  const signal = {
    aborted: false,
    reason: undefined as unknown,
    addEventListener(type: string, listener: () => void) {
      if (type === "abort") listeners.push(listener);
    },
    removeEventListener(_type: string, listener: () => void) {
      listeners.splice(listeners.indexOf(listener) >>> 0, 1);
    },
  };
  return {
    signal: signal as unknown as AbortSignal,
    abort(reason: Error) {
      signal.aborted = true;
      signal.reason = reason;
      for (const listener of listeners.splice(0)) listener();
    },
  };
}

test("a non-native abort signal cancels the request, bare or as an option, with the caller's own reason", async () => {
  for (const asOption of [false, true]) {
    const t = createTransport({ baseUrl: "http://x", fetchImpl: hangingFetchImpl(), requestTimeoutMs: 5_000 });
    const foreign = foreignAbortController();
    const pending = t.request("GET", "/api/v1/queue", undefined, asOption ? { signal: foreign.signal } : foreign.signal);
    const cancelled = new Error("cancelled by the UI");
    queueMicrotask(() => foreign.abort(cancelled));
    await assert.rejects(pending, (err: unknown) => {
      assert.equal(err, cancelled, `asOption=${asOption}: the caller's cancellation propagates as-is, got ${String(err)}`);
      return true;
    });
  }
});

test("a non-native abort signal that is already aborted cancels the request with its reason", async () => {
  const t = createTransport({ baseUrl: "http://x", fetchImpl: hangingFetchImpl(), requestTimeoutMs: 5_000 });
  const foreign = foreignAbortController();
  const cancelled = new Error("cancelled before sending");
  foreign.abort(cancelled);
  await assert.rejects(t.request("GET", "/api/v1/queue", undefined, foreign.signal), (err: unknown) => {
    assert.equal(err, cancelled);
    return true;
  });
});

test("a request that resolves before the timeout is unaffected", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ pending: 0, running: null }), { status: 200 })) as unknown as typeof fetch;
  const t = createTransport({ baseUrl: "http://x", fetchImpl, requestTimeoutMs: 10_000 });
  const result = await t.request<{ pending: number }>("GET", "/api/v1/queue");
  assert.equal(result.pending, 0);
});

/* Headers arrive at once but the body stalls, like a server that wedges mid-response. The body
   stream errors with the request signal's reason when it aborts, exactly as real fetch does. */
function stallingBodyFetchImpl(): typeof fetch {
  return (async (_url: string, init?: { signal?: AbortSignal }) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"pending":'));
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

/* Answers after `ms`, or rejects with the signal's reason if the request is aborted first. */
function slowFetchImpl(ms: number): typeof fetch {
  return (async (_url: string, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({ answer: "ok", pending: 0, running: null }), { status: 200 })), ms);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
    })) as unknown as typeof fetch;
}

test("a response body that stalls past the timeout fails as an ApiError timeout", async () => {
  const t = createTransport({ baseUrl: "http://x", fetchImpl: stallingBodyFetchImpl(), requestTimeoutMs: 5 });
  await assert.rejects(t.request("GET", "/api/v1/queue"), (err: unknown) => {
    assert.ok(err instanceof ApiError, `expected ApiError, got ${String(err)}`);
    assert.match((err as ApiError).message, /timed out/);
    return true;
  });
});

test("a per-call timeout lets one long request outlive the transport's default", async () => {
  const t = createTransport({ baseUrl: "http://x", fetchImpl: slowFetchImpl(40), requestTimeoutMs: 5 });
  await assert.rejects(t.request("GET", "/api/v1/queue"), ApiError, "the default still bounds an ordinary call");
  const result = await t.request<{ pending: number }>("GET", "/api/v1/queue", undefined, { timeoutMs: 1_000 });
  assert.equal(result.pending, 0);
});

test("assistant questions are not cut off by the short default request timeout", async () => {
  const client = createClient({ baseUrl: "http://x", fetchImpl: slowFetchImpl(40), requestTimeoutMs: 5 });
  await assert.rejects(client.getQueue(), ApiError, "an ordinary read keeps the short bound");
  assert.equal((await client.ask("r1", "why did it fail?")).answer, "ok");
  assert.equal((await client.help("how do I onboard an app?")).answer, "ok");
});
