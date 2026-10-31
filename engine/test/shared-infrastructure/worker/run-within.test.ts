/* The time a job is given is the time of the work and not the worker's fixed cost: its start (the thread, its module, the transfer of the bytes) is bounded on its own, the work from the moment the worker says it has begun. The outcome says how long each took. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDumpExecutor } from "@contexts/test-execution/infrastructure/run-dump-bridge.ts";
import { runWithin, type OffLoopExecutor, type OffLoopOutcome } from "../../../src/shared-infrastructure/worker/off-loop-executor.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const DONE: OffLoopOutcome = { kind: "done", outputs: [Buffer.from("x")] };

/* An executor that says it reports its start: it starts after `startAfterMs`, works for `workMs` and answers, unless it is told to stop first. */
function startAware(startAfterMs: number, workMs: number): OffLoopExecutor {
  return {
    reportsStart: true,
    run: async (_inputs, signal, _context, hooks) => {
      await sleep(startAfterMs);
      if (signal?.aborted) return { kind: "failed", reason: "aborted" };
      hooks?.onStarted();
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, workMs); signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
      return signal?.aborted ? { kind: "failed", reason: "aborted" } : DONE;
    },
  };
}

test("a worker that takes longer to start than the budget, and then works within it, is not stopped: the budget is for the work", async () => {
  const outcome = await runWithin(startAware(120, 20), [Buffer.from("a")], 60, undefined, 1_000);
  assert.equal(outcome.kind, "done");
  assert.ok((outcome.timing?.startMs ?? 0) >= 100, JSON.stringify(outcome.timing));
  assert.ok((outcome.timing?.workMs ?? 1e9) < 60, JSON.stringify(outcome.timing));
});

test("a worker that works past the budget once it has started is stopped, and the outcome says it started and how long it worked", async () => {
  const outcome = await runWithin(startAware(10, 5_000), [Buffer.from("a")], 60, undefined, 1_000);
  assert.deepEqual([outcome.kind, outcome.kind === "failed" ? outcome.reason : ""], ["failed", "aborted"]);
  assert.ok(outcome.timing?.startMs !== null && (outcome.timing?.workMs ?? 0) >= 50, JSON.stringify(outcome.timing));
});

test("a worker that never says it has started is unavailable after the time it is given to start, not aborted mid-work", async () => {
  const outcome = await runWithin(startAware(5_000, 0), [Buffer.from("a")], 60, undefined, 50);
  assert.deepEqual([outcome.kind, outcome.kind === "failed" ? outcome.reason : ""], ["failed", "unavailable"]);
  assert.equal(outcome.timing?.startMs, null);
});

test("an executor that does not report its start is given the budget from the call, as before", async () => {
  const plain: OffLoopExecutor = { run: (_inputs, signal) => new Promise<OffLoopOutcome>((resolve) => signal?.addEventListener("abort", () => resolve({ kind: "failed", reason: "aborted" }), { once: true })) };
  const outcome = await runWithin(plain, [Buffer.from("a")], 40);
  assert.deepEqual([outcome.kind, outcome.kind === "failed" ? outcome.reason : ""], ["failed", "aborted"]);
});

test("the real worker says when it starts, so a real read is timed from its work", async () => {
  const dump = Buffer.from(JSON.stringify([{ url: "https://dev.example/a.js", source: "x\n", functions: [] }]));
  const outcome = await runWithin(createDumpExecutor(), [dump], 10_000);
  assert.equal(outcome.kind, "done");
  assert.ok(typeof outcome.timing?.startMs === "number", JSON.stringify(outcome.timing));
});

test("no timer outlives the call, even when the worker reports its start after it has answered", async (t) => {
  const pending = new Set<unknown>();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", ((handler: () => void, ms?: number) => {
    const timer = realSetTimeout(handler, ms);
    pending.add(timer);
    return timer;
  }) as typeof setTimeout);
  t.mock.method(globalThis, "clearTimeout", ((timer: Parameters<typeof clearTimeout>[0]) => {
    pending.delete(timer);
    realClearTimeout(timer);
  }) as typeof clearTimeout);
  let lateStart!: () => void;
  const answersFirst: OffLoopExecutor = {
    reportsStart: true,
    run: async (_inputs, _signal, _context, hooks) => {
      lateStart = () => hooks?.onStarted();
      return DONE;
    },
  };

  const outcome = await runWithin(answersFirst, [Buffer.from("a")], 60_000, undefined, 60_000);
  lateStart();

  assert.equal(outcome.kind, "done");
  const left = pending.size;
  for (const timer of pending) realClearTimeout(timer as NodeJS.Timeout);
  assert.equal(left, 0, "a timer is left running after the call ended");
});
