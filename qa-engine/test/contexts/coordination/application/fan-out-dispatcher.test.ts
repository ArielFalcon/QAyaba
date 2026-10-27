import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FanOutDispatcher,
  FLOW_RESULT,
  type TimerPort,
} from "@contexts/coordination/application/fan-out-dispatcher.ts";
import { createAgentDeps, type RawAgentTransport } from "@contexts/generation/infrastructure/agent-transport-policy.ts";

/* A clock the test moves by hand: a timer fires when the clock reaches it, never before. */
class FakeTimers implements TimerPort {
  now = 0;
  private readonly pending = new Map<number, { at: number; fire: () => void }>();
  private next = 1;

  setTimer(ms: number, fire: () => void): () => void {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, fire });
    return () => { this.pending.delete(id); };
  }

  get open(): number {
    return this.pending.size;
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.pending]) {
      if (timer.at <= this.now) {
        this.pending.delete(id);
        timer.fire();
      }
    }
  }
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

const slot = (id: string, budgetMs = 1_000) => ({ id, budgetMs });

test("results come back in the order of the flows, whichever finishes first", async () => {
  const timers = new FakeTimers();
  const dispatcher = new FanOutDispatcher({ timers });
  const gates = new Map([["a", gate()], ["b", gate()]]);
  const run = dispatcher.run([slot("a"), slot("b")], { maxParallel: 2 }, async (flow) => { await gates.get(flow.id)!.promise; return flow.id.toUpperCase(); });
  await settle();
  gates.get("b")!.open();
  gates.get("a")!.open();
  const results = await run;
  assert.deepEqual(results.map((r) => [r.id, r.status, r.status === FLOW_RESULT.SETTLED ? r.value : undefined]), [["a", "settled", "A"], ["b", "settled", "B"]]);
});

test("no more flows run at once than the pool allows, and a freed place is taken by the next flow in line", async () => {
  const timers = new FakeTimers();
  const dispatcher = new FanOutDispatcher({ timers });
  const gates = new Map(["a", "b", "c", "d"].map((id) => [id, gate()] as const));
  let running = 0;
  let peak = 0;
  const started: string[] = [];
  const run = dispatcher.run(["a", "b", "c", "d"].map((id) => slot(id)), { maxParallel: 2 }, async (flow) => {
    started.push(flow.id);
    running += 1;
    peak = Math.max(peak, running);
    await gates.get(flow.id)!.promise;
    running -= 1;
  });
  await settle();
  assert.deepEqual(started, ["a", "b"]);
  gates.get("a")!.open();
  await settle();
  assert.deepEqual(started, ["a", "b", "c"], "the first place freed goes to the next flow in the order of the plan");
  for (const id of ["b", "c", "d"]) { gates.get(id)!.open(); await settle(); }
  await run;
  assert.equal(peak, 2);
});

test("a pool of less than one still runs the flows, one at a time", async () => {
  const dispatcher = new FanOutDispatcher({ timers: new FakeTimers() });
  let running = 0;
  let peak = 0;
  const results = await dispatcher.run([slot("a"), slot("b")], { maxParallel: 0 }, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await settle();
    running -= 1;
  });
  assert.equal(peak, 1);
  assert.equal(results.length, 2);
});

test("a flow's time starts when it starts, not while it waits for a place", async () => {
  const timers = new FakeTimers();
  const dispatcher = new FanOutDispatcher({ timers });
  const first = gate();
  const run = dispatcher.run([slot("a", 1_000), slot("b", 1_000)], { maxParallel: 1 }, async (flow) => { if (flow.id === "a") await first.promise; return flow.id; });
  await settle();
  timers.advance(900);
  first.open();
  await settle();
  timers.advance(900);
  const results = await run;
  assert.deepEqual(results.map((r) => r.status), [FLOW_RESULT.SETTLED, FLOW_RESULT.SETTLED], "b waited 900 ms and ran for none of its own 1000");
});

test("a flow that runs out of time is stopped through its own signal and the others go on", async () => {
  const timers = new FakeTimers();
  const dispatcher = new FanOutDispatcher({ timers });
  const slow = gate();
  const signals = new Map<string, AbortSignal>();
  const run = dispatcher.run([slot("slow", 500), slot("fast", 5_000)], { maxParallel: 2 }, async (flow, signal) => {
    signals.set(flow.id, signal);
    if (flow.id === "slow") {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return "late";
    }
    await slow.promise;
    return "fast-done";
  });
  await settle();
  timers.advance(500);
  await settle();
  assert.equal(signals.get("slow")!.aborted, true);
  assert.equal(signals.get("fast")!.aborted, false, "a signal is its flow's own");
  slow.open();
  const results = await run;
  assert.equal(results[0]!.status, FLOW_RESULT.TIMED_OUT);
  assert.deepEqual(results[1], { id: "fast", status: FLOW_RESULT.SETTLED, value: "fast-done" });
});

test("a flow that runs out of time has its transport session aborted through its signal and not deleted: the holder's dispose is the one delete", async () => {
  const timers = new FakeTimers();
  const dispatcher = new FanOutDispatcher({ timers });
  const calls: string[] = [];
  const raw: RawAgentTransport = {
    createSession: async () => ({ id: "sess-flow-budget" }),
    promptSession: () => new Promise(() => {}),
    abortSession: async (id) => void calls.push(`abort:${id}`),
    deleteSession: async (id) => void calls.push(`delete:${id}`),
  };
  const deps = createAgentDeps(raw, { defaultPromptTimeoutMs: 600_000, getFallbackModel: () => undefined });
  let session: Awaited<ReturnType<typeof deps.open>> | undefined;
  const run = dispatcher.run([slot("slow", 500)], { maxParallel: 1 }, async (_flow, signal) => {
    session = await deps.open("qa-author", "/tmp", { signal });
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  await settle();
  timers.advance(500);
  const results = await run;
  await settle();
  assert.equal(results[0]!.status, FLOW_RESULT.TIMED_OUT);
  assert.deepEqual(calls, ["abort:sess-flow-budget"], "the session saw the abort and no delete");
  await session!.dispose();
  assert.deepEqual(calls, ["abort:sess-flow-budget", "delete:sess-flow-budget"]);
});

test("a flow that ignores its stop does not hold its place for good", async () => {
  const timers = new FakeTimers();
  const dispatcher = new FanOutDispatcher({ timers, abortGraceMs: 200 });
  const forever = gate();
  const started: string[] = [];
  const run = dispatcher.run([slot("stuck", 100), slot("next", 1_000)], { maxParallel: 1 }, async (flow) => {
    started.push(flow.id);
    if (flow.id === "stuck") await forever.promise;
    return flow.id;
  });
  await settle();
  timers.advance(100);
  await settle();
  assert.deepEqual(started, ["stuck"], "the place is held while the flow may still be winding down");
  timers.advance(200);
  const results = await run;
  assert.deepEqual(started, ["stuck", "next"]);
  assert.deepEqual(results.map((r) => r.status), [FLOW_RESULT.TIMED_OUT, FLOW_RESULT.SETTLED]);
  forever.open();
});

test("what a flow that timed out finishes with afterwards is not read, and its failure is not an unhandled one", async () => {
  const timers = new FakeTimers();
  const dispatcher = new FanOutDispatcher({ timers, abortGraceMs: 10 });
  const late = gate();
  const run = dispatcher.run([slot("a", 100)], { maxParallel: 1 }, async () => { await late.promise; throw new Error("too late"); });
  await settle();
  timers.advance(100);
  await settle();
  timers.advance(10);
  const results = await run;
  late.open();
  await settle();
  assert.equal(results[0]!.status, FLOW_RESULT.TIMED_OUT);
});

test("a flow that throws is that flow's result and the others are unaffected", async () => {
  const dispatcher = new FanOutDispatcher({ timers: new FakeTimers() });
  const results = await dispatcher.run([slot("a"), slot("b"), slot("c")], { maxParallel: 3 }, async (flow) => {
    if (flow.id === "b") throw new Error("boom");
    return flow.id;
  });
  assert.deepEqual(results.map((r) => r.status), [FLOW_RESULT.SETTLED, FLOW_RESULT.THREW, FLOW_RESULT.SETTLED]);
  const thrown = results[1]!;
  assert.equal(thrown.status === FLOW_RESULT.THREW && thrown.error instanceof Error ? thrown.error.message : "", "boom");
});

test("a flow that throws before it first awaits is still only that flow's result", async () => {
  const dispatcher = new FanOutDispatcher({ timers: new FakeTimers() });
  const results = await dispatcher.run([slot("a")], { maxParallel: 1 }, () => { throw new Error("sync"); });
  assert.equal(results[0]!.status, FLOW_RESULT.THREW);
});

test("cancelling the run stops the running flows through their signals and starts none of the rest", async () => {
  const timers = new FakeTimers();
  const dispatcher = new FanOutDispatcher({ timers });
  const controller = new AbortController();
  const started: string[] = [];
  const run = dispatcher.run([slot("a"), slot("b"), slot("c")], { maxParallel: 1, signal: controller.signal }, async (flow, signal) => {
    started.push(flow.id);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  await settle();
  controller.abort();
  const results = await run;
  assert.deepEqual(started, ["a"]);
  assert.deepEqual(results.map((r) => r.status), [FLOW_RESULT.ABORTED, FLOW_RESULT.ABORTED, FLOW_RESULT.ABORTED]);
});

test("a run that is already cancelled starts nothing", async () => {
  const dispatcher = new FanOutDispatcher({ timers: new FakeTimers() });
  const controller = new AbortController();
  controller.abort();
  let ran = false;
  const results = await dispatcher.run([slot("a")], { maxParallel: 1, signal: controller.signal }, async () => { ran = true; });
  assert.equal(ran, false);
  assert.equal(results[0]!.status, FLOW_RESULT.ABORTED);
});

test("a flow that finished before the run was cancelled keeps its result", async () => {
  const dispatcher = new FanOutDispatcher({ timers: new FakeTimers() });
  const controller = new AbortController();
  const results = await dispatcher.run([slot("a"), slot("b")], { maxParallel: 1, signal: controller.signal }, async (flow) => {
    if (flow.id === "a") return "done";
    controller.abort();
    await new Promise<void>((r) => setImmediate(r));
    return "never read";
  });
  assert.deepEqual(results[0], { id: "a", status: FLOW_RESULT.SETTLED, value: "done" });
  assert.equal(results[1]!.status, FLOW_RESULT.ABORTED);
});

test("no timer is left pending once the flows are done, however they ended", async () => {
  const timers = new FakeTimers();
  const dispatcher = new FanOutDispatcher({ timers, abortGraceMs: 10 });
  await dispatcher.run([slot("ok"), slot("throws")], { maxParallel: 2 }, async (flow) => { if (flow.id === "throws") throw new Error("x"); });
  assert.equal(timers.open, 0);
  const hang = gate();
  const run = dispatcher.run([slot("hangs", 50)], { maxParallel: 1 }, async () => { await hang.promise; });
  await settle();
  timers.advance(50);
  await settle();
  timers.advance(10);
  await run;
  assert.equal(timers.open, 0);
  hang.open();
});
