import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountLock } from "@contexts/test-execution/domain/account-lock.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test("two holders of the same account never overlap and keep their arrival order", async () => {
  const lock = new AccountLock();
  const events: string[] = [];
  const gate = deferred();
  const first = lock.withLock("app/user", async () => {
    events.push("first:start");
    await gate.promise;
    events.push("first:end");
  });
  const second = lock.withLock("app/user", async () => {
    events.push("second:start");
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, ["first:start"], "the second waits while the first holds the account");
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
});

test("different accounts do not wait for each other", async () => {
  const lock = new AccountLock();
  const gate = deferred();
  const held = lock.withLock("app/a", () => gate.promise);
  let ran = false;
  await lock.withLock("app/b", async () => { ran = true; });
  assert.equal(ran, true);
  gate.resolve();
  await held;
});

test("a holder that throws releases the account, so nothing deadlocks behind it", async () => {
  const lock = new AccountLock();
  await assert.rejects(lock.withLock("app/user", async () => { throw new Error("boom"); }), /boom/);
  let ran = false;
  await lock.withLock("app/user", async () => { ran = true; });
  assert.equal(ran, true);
});

test("a waiter that is cancelled leaves the queue without ever holding the account", async () => {
  const lock = new AccountLock();
  const gate = deferred();
  const held = lock.withLock("app/user", () => gate.promise);
  const controller = new AbortController();
  let ran = false;
  const waiting = lock.withLock("app/user", async () => { ran = true; }, controller.signal);
  controller.abort();
  await assert.rejects(waiting, /aborted/);
  gate.resolve();
  await held;
  assert.equal(ran, false);
  let later = false;
  await lock.withLock("app/user", async () => { later = true; });
  assert.equal(later, true, "the queue still moves after a cancelled waiter");
});

test("a signal that is already aborted never takes the account", async () => {
  const lock = new AccountLock();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(lock.withLock("app/user", async () => "never", controller.signal), /aborted/);
});

test("a waiter that gives up does not let a later one in while the holder is still running", async () => {
  const lock = new AccountLock();
  const gate = deferred();
  const events: string[] = [];
  const held = lock.withLock("app/user", async () => { events.push("holder:start"); await gate.promise; events.push("holder:end"); });
  const controller = new AbortController();
  const gaveUp = lock.withLock("app/user", async () => { events.push("gave-up:ran"); }, controller.signal);
  controller.abort();
  await assert.rejects(gaveUp, /aborted/);
  const later = lock.withLock("app/user", async () => { events.push("later:start"); });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, ["holder:start"], "the later waiter queues behind the holder, not behind the waiter that left");
  gate.resolve();
  await Promise.all([held, later]);
  assert.deepEqual(events, ["holder:start", "holder:end", "later:start"]);
});

test("a waiter that gives up behind another waiter does not open the account to a third", async () => {
  const lock = new AccountLock();
  const gate = deferred();
  const events: string[] = [];
  const held = lock.withLock("app/user", async () => { events.push("a:start"); await gate.promise; events.push("a:end"); });
  const middle = lock.withLock("app/user", async () => { events.push("b:start"); });
  const controller = new AbortController();
  const gaveUp = lock.withLock("app/user", async () => { events.push("c:ran"); }, controller.signal);
  controller.abort();
  await assert.rejects(gaveUp, /aborted/);
  const last = lock.withLock("app/user", async () => { events.push("d:start"); });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, ["a:start"]);
  gate.resolve();
  await Promise.all([held, middle, last]);
  assert.deepEqual(events, ["a:start", "a:end", "b:start", "d:start"]);
});
