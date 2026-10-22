import { test } from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "./queue";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("processes one at a time (no overlap) and in order", async () => {
  const q = new JobQueue();
  const order: string[] = [];
  let running = 0;
  let maxConcurrent = 0;

  const job = (id: string, ms: number) => async () => {
    running++;
    maxConcurrent = Math.max(maxConcurrent, running);
    await tick(ms);
    order.push(id);
    running--;
  };

  q.enqueue(job("a", 20));
  q.enqueue(job("b", 5));
  q.enqueue(job("c", 1));
  await q.drain();

  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(maxConcurrent, 1); /* never two at once */
});

test("a failing job does not stop the following ones", async () => {
  const errors: unknown[] = [];
  const q = new JobQueue((e) => errors.push(e));
  const done: string[] = [];

  q.enqueue(async (_signal) => {
    throw new Error("boom");
  });
  q.enqueue(async (_signal) => {
    done.push("next");
  });
  await q.drain();

  assert.equal(errors.length, 1);
  assert.deepEqual(done, ["next"]);
});

test("size reflects pending work and returns to 0 after draining", async () => {
  const q = new JobQueue();
  q.enqueue(async (_signal) => await tick(5));
  q.enqueue(async (_signal) => await tick(5));
  assert.equal(q.size, 2);
  await q.drain();
  assert.equal(q.size, 0);
});

test("cancel aborts the currently-running job via AbortSignal", async () => {
  const q = new JobQueue();
  let aborted = false;

  q.enqueue(async (signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      }, { once: true });
      /* Never resolve naturally */
    });
  });

  await tick(5);
  assert.equal(aborted, false);
  assert.equal(q.cancel(), true);
  await tick(5);
  assert.equal(aborted, true);
});

test("cancel returns false when no job is running", () => {
  const q = new JobQueue();
  assert.equal(q.cancel(), false);
});

test("cancel(runId) aborts only when the id matches the running job (no wrong-run kill)", async () => {
  const q = new JobQueue();
  let aborted = false;
  q.enqueue(async (signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
    });
  }, "run-A");

  await tick(5);
  /* A stale cancel naming a DIFFERENT run must NOT abort the run that is actually executing
     (this is the guard the cancelRun fix in index.ts relies on).
   */
  assert.equal(q.cancel("run-B"), false);
  await tick(5);
  assert.equal(aborted, false, "cancel('run-B') must not abort run-A");

  assert.equal(q.cancel("run-A"), true);
  await tick(5);
  assert.equal(aborted, true);
});

test("an idle job waits for the queue to empty and never runs beside a normal job", async () => {
  const q = new JobQueue();
  const events: string[] = [];
  let running = 0;
  let maxConcurrent = 0;
  const track = (id: string, ms: number) => async () => {
    running++;
    maxConcurrent = Math.max(maxConcurrent, running);
    events.push(`start ${id}`);
    await tick(ms);
    events.push(`end ${id}`);
    running--;
  };
  q.enqueue(track("run-a", 15));
  q.enqueueIdle(track("judge", 5));
  q.enqueue(track("run-b", 5));
  await tick(60);
  await q.drain();
  assert.deepEqual(events, ["start run-a", "end run-a", "start run-b", "end run-b", "start judge", "end judge"]);
  assert.equal(maxConcurrent, 1);
});

test("an idle job does not count as pending work, so the queue still reads as idle for callers that check its size", async () => {
  const q = new JobQueue();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  q.enqueueIdle(async () => gate);
  await tick(5);
  assert.equal(q.size, 0);
  assert.equal(q.current, null);
  release();
  await q.drain();
});

test("a run enqueued while an idle job runs waits for it, and the idle job is told to yield at once", async () => {
  const q = new JobQueue();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let yieldedWhenRunArrived: boolean | undefined;
  q.enqueueIdle(async (_signal, shouldYield) => {
    order.push("judge start");
    await gate;
    yieldedWhenRunArrived = shouldYield();
    order.push("judge end");
  });
  await tick(5);
  q.enqueue(async () => {
    order.push("run");
  });
  release();
  await q.drain();
  assert.deepEqual(order, ["judge start", "judge end", "run"]);
  assert.equal(yieldedWhenRunArrived, true);
});

test("idle jobs run one after another once the queue is empty, and a failing one does not stop the next", async () => {
  const errors: unknown[] = [];
  const q = new JobQueue((e) => errors.push(e));
  const done: string[] = [];
  q.enqueueIdle(async () => {
    throw new Error("judge crashed");
  });
  q.enqueueIdle(async () => {
    done.push("second");
  });
  await tick(10);
  await q.drain();
  assert.equal(errors.length, 1);
  assert.deepEqual(done, ["second"]);
});

test("cancelling a run by id never aborts an idle job", async () => {
  const q = new JobQueue();
  let aborted = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  q.enqueueIdle(async (signal) => {
    signal.addEventListener("abort", () => (aborted = true));
    await gate;
  });
  await tick(5);
  assert.equal(q.cancel("run-x"), false);
  assert.equal(aborted, false);
  release();
  await q.drain();
});

test("a run enqueued while an idle job runs aborts it, and a drain aborts it instead of waiting it out", async () => {
  const q = new JobQueue();
  const seen: string[] = [];
  const idle = (name: string) => async (signal: AbortSignal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    seen.push(`${name} aborted`);
  };
  q.enqueueIdle(idle("first"));
  await tick(5);
  q.enqueue(async () => void seen.push("run"));
  await q.drain();
  assert.deepEqual(seen, ["first aborted", "run"]);

  const d = new JobQueue();
  d.enqueueIdle(idle("second"));
  await tick(5);
  await d.drain();
  assert.deepEqual(seen.slice(2), ["second aborted"]);
});
