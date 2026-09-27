/*
 * The web console's live run feed (api.js subscribeRun) against a scripted control API. These pin
 * what the operator's browser does to the server: it follows a live run to its verdict, it never
 * reconnects without waiting, and it stops for good once the run is over or access is refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConsole, sseEvent, type ConsoleRequest, type Reply } from "./console-harness";

const EVENTS = "/api/v1/runs/r1/events";
const MINUTE = 60_000;

function runRecord(status: "running" | "done", verdict?: string) {
  return {
    id: "r1", app: "shop", sha: "abcdef1", target: "e2e", mode: "diff", status,
    ...(verdict ? { verdict } : {}), cases: [], logs: [], at: new Date(0).toISOString(),
  };
}

/* A control API whose run record and event stream are both scripted by the test. */
function server(opts: { record: () => ReturnType<typeof runRecord>; stream: (req: ConsoleRequest, n: number) => Reply }) {
  let streams = 0;
  return (req: ConsoleRequest): Reply => {
    if (req.path === EVENTS) return opts.stream(req, streams++);
    if (req.path === "/api/v1/runs/r1") return { status: 200, json: opts.record() };
    return { status: 404, json: { error: "not found" } };
  };
}

function eventRequestTimes(requests: ConsoleRequest[]): number[] {
  return requests.filter((r) => r.path === EVENTS).map((r) => r.at);
}

test("never reconnects to a run's event stream without waiting first", async (t) => {
  /* A live run whose connection keeps closing cleanly — with and without replayed events. */
  const h = await loadConsole({
    token: "t",
    routes: server({
      record: () => runRecord("running"),
      stream: (_req, n) => ({ status: 200, sse: n % 2 === 0 ? [] : [sseEvent("r1", n, { type: "step.changed", step: "generate" })] }),
    }),
  });
  const unsubscribe = h.api.subscribeRun("r1", {});
  t.after(() => unsubscribe?.());
  await h.advance(2 * MINUTE);

  const times = eventRequestTimes(h.requests);
  assert.ok(times.length > 1, "the live run must be followed across closes");
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i]! > times[i - 1]!, `reconnect ${i} happened at the same instant as the previous request`);
  }
});

test("stops following a finished run whose stream closes without a verdict, and reports the recorded verdict", async (t) => {
  /* A run cancelled while enqueued: the record is done but no run.verdict was ever published. */
  const h = await loadConsole({
    token: "t",
    routes: server({ record: () => runRecord("done", "infra-error"), stream: () => ({ status: 200, sse: [] }) }),
  });
  const verdicts: string[] = [];
  const unsubscribe = h.api.subscribeRun("r1", { onVerdict: (v) => verdicts.push(v) });
  t.after(() => unsubscribe?.());

  await h.advance(10 * MINUTE);
  const afterTen = eventRequestTimes(h.requests).length;
  await h.advance(10 * MINUTE);

  assert.equal(eventRequestTimes(h.requests).length, afterTen, "the finished run's stream must not be reopened");
  assert.ok(afterTen <= 5, `a finished run is reconnected a handful of times at most, saw ${afterTen}`);
  assert.deepEqual(verdicts, ["infra-error"], "the console learns the run is over from its record");
});

test("stops following a finished run after its replayed events end without a verdict", async (t) => {
  const h = await loadConsole({
    token: "t",
    routes: server({
      record: () => runRecord("done", "infra-error"),
      stream: (req) => ({
        status: 200,
        sse: req.headers["last-event-id"] ? [] : [sseEvent("r1", 0, { type: "run.started", app: "shop", sha: "abcdef1", mode: "diff", target: "e2e" })],
      }),
    }),
  });
  const unsubscribe = h.api.subscribeRun("r1", {});
  t.after(() => unsubscribe?.());

  await h.advance(10 * MINUTE);
  const afterTen = eventRequestTimes(h.requests).length;
  await h.advance(10 * MINUTE);

  assert.equal(eventRequestTimes(h.requests).length, afterTen);
  assert.ok(afterTen <= 5, `saw ${afterTen} reconnects to a finished run`);
});

for (const status of [401, 403, 404]) {
  test(`treats HTTP ${status} on the event stream as final: one request, no retries`, async (t) => {
    const h = await loadConsole({
      token: "t",
      routes: server({ record: () => runRecord("running"), stream: () => ({ status, json: { error: "no" } }) }),
    });
    let errors = 0;
    const unsubscribe = h.api.subscribeRun("r1", { onError: () => errors++ });
    t.after(() => unsubscribe?.());

    await h.advance(30 * MINUTE);

    assert.equal(eventRequestTimes(h.requests).length, 1);
    assert.ok(errors >= 1, "the caller is told the feed failed");
  });
}

test("a 401 on the event stream forgets the stored session token", async (t) => {
  const h = await loadConsole({
    token: "t",
    routes: server({ record: () => runRecord("running"), stream: () => ({ status: 401, json: { error: "auth" } }) }),
  });
  const unsubscribe = h.api.subscribeRun("r1", {});
  t.after(() => unsubscribe?.());
  await h.advance(MINUTE);
  assert.equal(h.storage.has("qayaba_token"), false);
});

test("keeps following a live run through clean closes and resumes from the last event it saw", async (t) => {
  let recordStatus: "running" | "done" = "running";
  const h = await loadConsole({
    token: "t",
    routes: server({
      record: () => runRecord(recordStatus, recordStatus === "done" ? "pass" : undefined),
      stream: (_req, n) => {
        if (n === 0) return { status: 200, sse: [sseEvent("r1", 0, { type: "step.changed", step: "generate" })] };
        if (n < 5) return { status: 200, sse: [] }; /* proxy idle-timeouts while the agent works */
        recordStatus = "done";
        return { status: 200, sse: [sseEvent("r1", 1, { type: "run.verdict", verdict: "pass", engineStatus: "success" })] };
      },
    }),
  });
  const verdicts: string[] = [];
  const steps: string[] = [];
  const unsubscribe = h.api.subscribeRun("r1", { onVerdict: (v) => verdicts.push(v), onStep: (s) => steps.push(s) });
  t.after(() => unsubscribe?.());

  await h.advance(10 * MINUTE);

  assert.deepEqual(steps, ["generate"], "an event is applied once, never replayed twice");
  assert.deepEqual(verdicts, ["pass"], "the live run is followed until its verdict");
  const reconnects = h.requests.filter((r) => r.path === EVENTS).slice(1);
  assert.ok(reconnects.every((r) => r.headers["last-event-id"] === "0"), "every reconnect resumes after the last seen event");
});

test("retries a transient server error and recovers the feed", async (t) => {
  const h = await loadConsole({
    token: "t",
    routes: server({
      record: () => runRecord("running"),
      stream: (_req, n) => n < 2
        ? { status: 503, json: { error: "busy" } }
        : { status: 200, sse: [sseEvent("r1", 0, { type: "run.verdict", verdict: "fail", engineStatus: "success" })] },
    }),
  });
  const verdicts: string[] = [];
  const unsubscribe = h.api.subscribeRun("r1", { onVerdict: (v) => verdicts.push(v) });
  t.after(() => unsubscribe?.());

  await h.advance(5 * MINUTE);

  assert.deepEqual(verdicts, ["fail"]);
});

test("releases the connection once the verdict arrives, even if the server keeps it open", async (t) => {
  const h = await loadConsole({
    token: "t",
    routes: server({
      record: () => runRecord("done", "pass"),
      stream: () => ({ status: 200, hold: true, sse: [sseEvent("r1", 0, { type: "run.verdict", verdict: "pass", engineStatus: "success" })] }),
    }),
  });
  const unsubscribe = h.api.subscribeRun("r1", {});
  t.after(() => unsubscribe?.());
  await h.advance(MINUTE);

  const [stream] = h.requests.filter((r) => r.path === EVENTS);
  assert.equal(stream?.released, true);
});

test("unsubscribing stops every further reconnect", async () => {
  const h = await loadConsole({
    token: "t",
    routes: server({ record: () => runRecord("running"), stream: () => ({ status: 500, json: { error: "down" } }) }),
  });
  const unsubscribe = h.api.subscribeRun("r1", {});
  await h.advance(5_000);
  unsubscribe?.();
  const atUnsubscribe = eventRequestTimes(h.requests).length;

  await h.advance(30 * MINUTE);

  assert.equal(eventRequestTimes(h.requests).length, atUnsubscribe);
});
