/* qa-engine/test/contexts/generation/infrastructure/sse/event-stream.test.ts
   characterization tests exercise the SSE lifecycle POLICY (reconnect-with-backoff,
   refcounted per-directory subscription lifecycle) that now lives in event-stream.ts, decoupled
   from the SDK (openStream is injected in every test — none rely on the real raw opener).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startEventStreamWithReconnect,
  startScopedEventStream,
  startActivitySink,
  registerRunSession,
  unregisterRunSession,
  EventStreamManager,
  setRawEventStreamOpener,
} from "@contexts/generation/infrastructure/sse/event-stream.ts";
import {
  callEfficiencyTracker,
  type StreamLifecycleSink,
  type StreamToken,
} from "@contexts/generation/infrastructure/sse/call-efficiency-tracker.ts";
import { registerSessionWatchdogNotify, unregisterSessionWatchdogNotify } from "@contexts/generation/infrastructure/agent-transport-policy.ts";

test("startEventStreamWithReconnect retries after a stream error until aborted", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const delays: number[] = [];
  const logs: string[] = [];

  await startEventStreamWithReconnect(
    () => {},
    controller.signal,
    {
      initialDelayMs: 10,
      maxDelayMs: 20,
      log: (msg) => logs.push(msg),
      sleep: async (ms) => { delays.push(ms); },
      start: async () => {
        attempts++;
        if (attempts === 1) throw new Error("opencode down");
        controller.abort();
      },
    },
  );

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [10]);
  assert.match(logs.join("\n"), /opencode down/);
});

test("startEventStreamWithReconnect reconnects after a clean stream close", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const delays: number[] = [];

  await startEventStreamWithReconnect(
    () => {},
    controller.signal,
    {
      initialDelayMs: 5,
      sleep: async (ms) => { delays.push(ms); },
      start: async () => {
        attempts++;
        if (attempts === 2) controller.abort();
      },
    },
  );

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [5]);
});

/* v2 has no global firehose, so the orchestrator opens ONE scoped event.subscribe
   per run directory. The manager refcounts them (parallelDiff sessions share a dir)
   and closes a stream when its last session unregisters. openStream is injected so
   the demux/lifecycle is unit-tested without the SDK.
 */
test("EventStreamManager opens one scoped stream per directory (refcounted) and closes on last detach", () => {
  const opened: Array<{ dir: string; signal: AbortSignal }> = [];
  const mgr = new EventStreamManager((dir, _onActivity, signal) => { opened.push({ dir, signal }); });
  mgr.setSink(() => {}, new AbortController().signal);

  mgr.attach("s1", "/m/a");
  mgr.attach("s2", "/m/a"); /* same dir → shares the stream (refcount), no second open */
  mgr.attach("s3", "/m/b");

  assert.deepEqual(opened.map((o) => o.dir).sort(), ["/m/a", "/m/b"]);
  assert.equal(opened.length, 2);

  const a = opened.find((o) => o.dir === "/m/a")!;
  mgr.detach("s1"); /* /m/a refs 2→1, still open */
  assert.equal(a.signal.aborted, false);
  mgr.detach("s2");
  assert.equal(a.signal.aborted, true);
  assert.equal(opened.find((o) => o.dir === "/m/b")!.signal.aborted, false);
});

test("EventStreamManager defers opening a stream until the sink is set", () => {
  const opened: string[] = [];
  const mgr = new EventStreamManager((dir) => { opened.push(dir); });
  mgr.attach("s1", "/m/a"); /* no sink yet → nothing opens */
  assert.deepEqual(opened, []);
  mgr.setSink(() => {}, new AbortController().signal);
  assert.deepEqual(opened, ["/m/a"]); /* opened once the sink arrives */
});

/* The default (non-injected) stream path — EventStreamManager -> defaultOpenStream ->
   startEventStreamWithReconnect -> startScopedEventStream -> RawEventStreamOpener.open — must
   forward the per-directory AbortSignal into open() itself, not just check `signal?.aborted`
   between already-buffered events. Without this, detach()/closeAll() abort a signal nothing
   downstream ever listens to at the transport level, so the underlying SSE HTTP connection is
   never actually torn down.
 */
test("the default stream path forwards the per-directory AbortSignal into RawEventStreamOpener.open so detach can tear the connection down", () => {
  const openCalls: Array<{ directory: string; signal: AbortSignal | undefined }> = [];
  const restoreOpener = setRawEventStreamOpener({
    open: async (directory, signal) => {
      openCalls.push({ directory, signal });
      return undefined; /* no stream — startScopedEventStream logs a warning and returns cleanly */
    },
  });

  /* No injected openStream — this exercises the REAL defaultOpenStream -> rawOpener path, which
     runs a real (unmocked) reconnect-with-backoff loop in the background. detach() in a `finally`
     is load-bearing: without it, an assertion failure here would leave that loop's real setTimeout
     alive and the test process would hang instead of failing fast.
   */
  const mgr = new EventStreamManager();
  mgr.setSink(() => {});
  mgr.attach("s1", "/m/real-dir");

  try {
    assert.equal(openCalls.length, 1);
    assert.equal(openCalls[0]!.directory, "/m/real-dir");
    assert.ok(openCalls[0]!.signal, "the per-directory AbortSignal must be forwarded to RawEventStreamOpener.open");
    assert.equal(openCalls[0]!.signal!.aborted, false);
  } finally {
    mgr.detach("s1");
    restoreOpener();
  }
  assert.equal(openCalls[0]!.signal!.aborted, true, "detach must abort the SAME signal instance that was forwarded to open()");
});

test("restoring a swapped opener puts the previously wired one back", () => {
  const opened: string[] = [];
  const restoreWired = setRawEventStreamOpener({ open: async () => { opened.push("wired"); return undefined; } });
  const restoreSwap = setRawEventStreamOpener({ open: async () => { opened.push("swap"); return undefined; } });
  restoreSwap();

  const mgr = new EventStreamManager();
  mgr.setSink(() => {});
  mgr.attach("s-restore", "/m/restore-dir");
  try {
    assert.deepEqual(opened, ["wired"]);
  } finally {
    mgr.detach("s-restore");
    restoreWired();
  }
});

test("EventStreamManager closes every directory stream on shutdown and ignores later attaches", () => {
  const opened: Array<{ dir: string; signal: AbortSignal }> = [];
  const shutdown = new AbortController();
  const mgr = new EventStreamManager((dir, _oa, signal) => { opened.push({ dir, signal }); });
  mgr.setSink(() => {}, shutdown.signal);
  mgr.attach("s1", "/m/a");
  mgr.attach("s2", "/m/b");

  shutdown.abort();
  assert.ok(opened.every((o) => o.signal.aborted), "all directory streams aborted on shutdown");
  mgr.attach("s3", "/m/c");
  assert.equal(opened.length, 2);
});

function toolPartEvent(sessionID: string, callID: string, tool: string, input: Record<string, unknown>): { type: string; properties: Record<string, unknown> } {
  return {
    type: "message.part.updated",
    properties: {
      part: { id: `prt-${sessionID}-${callID}`, sessionID, messageID: "m", type: "tool", callID, tool, state: { status: "completed", input, output: "ok" } },
    },
  };
}

/** Streams the given raw events through the real SSE loop for sessions registered via registerRunSession. */
async function streamThroughRegisteredSessions(
  sessions: string[],
  events: Array<{ type: string; properties: Record<string, unknown> }>,
  whileRegistered: () => void,
): Promise<void> {
  let drained!: () => void;
  const allProcessed = new Promise<void>((resolve) => { drained = resolve; });
  let firstOpen = true;
  const restoreOpener = setRawEventStreamOpener({
    open: async () => {
      if (!firstOpen) return undefined;
      firstOpen = false;
      return (async function* () {
        for (const event of events) yield event;
        drained();
      })();
    },
  });
  const shutdown = new AbortController();
  void startActivitySink(() => {}, shutdown.signal);
  try {
    for (const sessionId of sessions) registerRunSession(sessionId, "run-1", "/m/sse-dir");
    await allProcessed;
    whileRegistered();
  } finally {
    for (const sessionId of sessions) unregisterRunSession(sessionId);
    shutdown.abort();
    restoreOpener();
  }
}

test("events of a registered run session reach the call tracker, and unregistering forgets the session", async () => {
  const events = [
    toolPartEvent("sess-tracked", "c1", "read", { filePath: "/m/sse-dir/a.ts" }),
    toolPartEvent("sess-tracked", "c2", "write", { filePath: "/m/sse-dir/e2e/a.spec.ts" }),
    toolPartEvent("sess-stranger", "c1", "read", { filePath: "/m/sse-dir/a.ts" }),
  ];
  let metrics: ReturnType<typeof callEfficiencyTracker.take> = null;
  let strangerMetrics: ReturnType<typeof callEfficiencyTracker.take> = null;
  await streamThroughRegisteredSessions(["sess-tracked"], events, () => {
    metrics = callEfficiencyTracker.take("sess-tracked", "");
    strangerMetrics = callEfficiencyTracker.take("sess-stranger", "");
  });

  assert.equal(metrics!.totalCalls, 2);
  assert.equal(metrics!.writeCount, 1);
  assert.equal(strangerMetrics, null, "a session that was never registered must not be tracked");
  assert.equal(callEfficiencyTracker.take("sess-tracked", ""), null, "unregistering must clear the session's tracker state");
});

test("a tracking fault on one session neither starves any session's watchdog nor stops the loop", async (t) => {
  t.mock.method(console, "error", () => {});
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const events = [
    toolPartEvent("sess-bad", "c1", "read", circular),
    toolPartEvent("sess-good", "c1", "read", { filePath: "/m/sse-dir/a.ts" }),
    toolPartEvent("sess-bad", "c2", "read", { filePath: "/m/sse-dir/b.ts" }),
    toolPartEvent("sess-good", "c2", "write", { filePath: "/m/sse-dir/e2e/a.spec.ts" }),
  ];
  const notified: string[] = [];
  registerSessionWatchdogNotify("sess-bad", () => notified.push("bad"));
  registerSessionWatchdogNotify("sess-good", () => notified.push("good"));
  let badMetrics: ReturnType<typeof callEfficiencyTracker.take> = null;
  let goodMetrics: ReturnType<typeof callEfficiencyTracker.take> = null;
  try {
    await streamThroughRegisteredSessions(["sess-bad", "sess-good"], events, () => {
      badMetrics = callEfficiencyTracker.take("sess-bad", "");
      goodMetrics = callEfficiencyTracker.take("sess-good", "");
    });
  } finally {
    unregisterSessionWatchdogNotify("sess-bad");
    unregisterSessionWatchdogNotify("sess-good");
  }

  assert.deepEqual(notified, ["bad", "good", "bad", "good"], "every event must keep its watchdog alive, whatever the tracker does");
  assert.equal(badMetrics, null);
  assert.equal(goodMetrics!.totalCalls, 2);
});

interface LifecycleCall {
  kind: "opening" | "connected" | "interrupted" | "closed";
  directory: string;
  token: StreamToken;
}

/** Records the stream lifecycle a scoped stream reports, in order. */
class RecordingLifecycle implements StreamLifecycleSink {
  readonly calls: LifecycleCall[] = [];
  streamOpening(directory: string, token: StreamToken): void { this.calls.push({ kind: "opening", directory, token }); }
  streamConnected(directory: string, token: StreamToken): void { this.calls.push({ kind: "connected", directory, token }); }
  streamInterrupted(directory: string, token: StreamToken): void { this.calls.push({ kind: "interrupted", directory, token }); }
  streamClosed(directory: string, token: StreamToken): void { this.calls.push({ kind: "closed", directory, token }); }
  get kinds(): string[] { return this.calls.map((c) => c.kind); }
}

const DIR = "/m/lifecycle";
const connectedEvent = { type: "server.connected", properties: {} };

async function runScopedStream(
  opener: (lifecycle: RecordingLifecycle) => RawEventStreamOpenerOpen,
  signal?: AbortSignal,
): Promise<RecordingLifecycle> {
  const lifecycle = new RecordingLifecycle();
  const restore = setRawEventStreamOpener({ open: opener(lifecycle) });
  try {
    await startScopedEventStream(DIR, () => {}, signal, undefined, lifecycle);
  } finally {
    restore();
  }
  return lifecycle;
}

type RawEventStreamOpenerOpen = Parameters<typeof setRawEventStreamOpener>[0]["open"];

function streamOf(events: unknown[]): AsyncIterable<{ type?: string; properties?: Record<string, unknown> }> {
  return (async function* () {
    for (const event of events) yield event as { type?: string; properties?: Record<string, unknown> };
  })();
}

test("a stream that runs to a clean end is opened, connected by its first event and closed, all under one token", async () => {
  const lifecycle = await runScopedStream(() => async () => streamOf([connectedEvent, toolPartEvent("s", "c1", "read", {})]));
  assert.deepEqual(lifecycle.kinds, ["opening", "connected", "closed"]);
  assert.equal(new Set(lifecycle.calls.map((c) => c.token)).size, 1);
  assert.ok(lifecycle.calls.every((c) => c.directory === DIR));
});

test("the stream is reported opening before the opener is asked for it, so a waiting attempt can see it", async () => {
  let seenWhenOpening: string[] = [];
  await runScopedStream((lifecycle) => async () => {
    seenWhenOpening = lifecycle.kinds;
    return streamOf([]);
  });
  assert.deepEqual(seenWhenOpening, ["opening"]);
});

test("every connection reports its own token", async () => {
  const first = await runScopedStream(() => async () => streamOf([connectedEvent]));
  const second = await runScopedStream(() => async () => streamOf([connectedEvent]));
  assert.notEqual(first.calls[0]!.token, second.calls[0]!.token);
});

test("a second connected event on the same stream is reported again", async () => {
  const lifecycle = await runScopedStream(() => async () => streamOf([connectedEvent, connectedEvent]));
  assert.deepEqual(lifecycle.kinds, ["opening", "connected", "connected", "closed"]);
});

test("a stream that the opener cannot open is closed under its token and the opener's error still propagates", async () => {
  const lifecycle = new RecordingLifecycle();
  const restore = setRawEventStreamOpener({ open: async () => { throw new Error("opener down"); } });
  try {
    await assert.rejects(() => startScopedEventStream(DIR, () => {}, undefined, undefined, lifecycle), /opener down/);
  } finally {
    restore();
  }
  assert.deepEqual(lifecycle.kinds, ["opening", "closed"]);
  assert.equal(lifecycle.calls[0]!.token, lifecycle.calls[1]!.token);
});

test("an opener that returns no stream still closes the stream it announced", async (t) => {
  t.mock.method(console, "warn", () => {});
  const lifecycle = await runScopedStream(() => async () => undefined);
  assert.deepEqual(lifecycle.kinds, ["opening", "closed"]);
});

test("a stream aborted mid-way is closed", async () => {
  const controller = new AbortController();
  const lifecycle = await runScopedStream(
    () => async () =>
      (async function* () {
        yield connectedEvent;
        controller.abort();
        yield toolPartEvent("s", "c1", "read", {});
      })(),
    controller.signal,
  );
  assert.deepEqual(lifecycle.kinds, ["opening", "connected", "closed"]);
});

test("a stream whose iteration fails is closed, and the failure is logged rather than thrown", async (t) => {
  const warned = t.mock.method(console, "warn", () => {});
  const lifecycle = await runScopedStream(
    () => async () =>
      (async function* () {
        yield connectedEvent;
        throw new Error("socket reset");
      })(),
  );
  assert.deepEqual(lifecycle.kinds, ["opening", "connected", "closed"]);
  assert.match(String(warned.mock.calls[0]?.arguments[0]), /socket reset/);
});

test("a stream attempted before an opener is wired throws without announcing anything", async () => {
  const lifecycle = new RecordingLifecycle();
  const restoreEmpty = setRawEventStreamOpener({ open: async () => undefined });
  restoreEmpty(); /* the previously wired opener (none) is put back */
  await assert.rejects(() => startScopedEventStream(DIR, () => {}, undefined, undefined, lifecycle), /no RawEventStreamOpener wired/);
  assert.deepEqual(lifecycle.kinds, []);
});

test("the opener is handed a callback that reports the stream interrupted under its token", async () => {
  const lifecycle = await runScopedStream(() => async (_directory, _signal, onSseError) => {
    onSseError?.(new Error("connection reset"));
    return streamOf([connectedEvent]);
  });
  assert.deepEqual(lifecycle.kinds, ["opening", "interrupted", "connected", "closed"]);
  assert.equal(new Set(lifecycle.calls.map((c) => c.token)).size, 1);
});
