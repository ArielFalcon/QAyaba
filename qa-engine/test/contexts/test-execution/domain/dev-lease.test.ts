import { test } from "node:test";
import assert from "node:assert/strict";
import { DevLease } from "@contexts/test-execution/domain/dev-lease.ts";
import { AccountLock } from "@contexts/test-execution/domain/account-lock.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

test("a lease is an account lock, so the actions that take it by that name are served", async () => {
  const lease = new DevLease();
  assert.ok(lease instanceof AccountLock);
  assert.equal(await lease.withLock("app/user", async () => "served"), "served");
});

test("a holder takes DEV exclusively: another account waits for it", async () => {
  const lease = new DevLease();
  const gate = deferred();
  const events: string[] = [];
  const first = lease.withLock("app/a", async () => { events.push("a:start"); await gate.promise; events.push("a:end"); });
  const second = lease.withLock("app/b", async () => { events.push("b:start"); });
  await settle();
  assert.deepEqual(events, ["a:start"], "an action is alone on DEV, whoever the account is");
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a:start", "a:end", "b:start"]);
});

test("DEV is granted in the order it was asked for", async () => {
  const lease = new DevLease();
  const gate = deferred();
  const events: string[] = [];
  const held = lease.withLock("app/a", async () => { await gate.promise; });
  const b = lease.withLock("app/b", async () => { events.push("b"); });
  const c = lease.withLock("app/c", async () => { events.push("c"); });
  await settle();
  gate.resolve();
  await Promise.all([held, b, c]);
  assert.deepEqual(events, ["b", "c"]);
});

test("with one account every action is strictly serial", async () => {
  const lease = new DevLease();
  let running = 0;
  let peak = 0;
  const hold = async (): Promise<void> => { running += 1; peak = Math.max(peak, running); await settle(); running -= 1; };
  await Promise.all([lease.withLock("app/a", hold), lease.withLock("app/a", hold), lease.withLock("app/a", hold)]);
  assert.equal(peak, 1);
});

test("a holder that throws gives DEV back, so nothing waits behind it for good", async () => {
  const lease = new DevLease();
  await assert.rejects(lease.withLock("app/a", async () => { throw new Error("boom"); }), /boom/);
  let ran = false;
  await lease.withLock("app/b", async () => { ran = true; });
  assert.equal(ran, true);
});

test("a waiter that gives up never holds DEV and does not hold up the ones behind it", async () => {
  const lease = new DevLease();
  const gate = deferred();
  const events: string[] = [];
  const held = lease.withLock("app/a", async () => { events.push("held:start"); await gate.promise; });
  const controller = new AbortController();
  const gaveUp = lease.withLock("app/b", async () => { events.push("gave-up:ran"); }, controller.signal);
  const behind = lease.withLock("app/c", async () => { events.push("behind:ran"); });
  await settle();
  controller.abort();
  await assert.rejects(gaveUp, /aborted/);
  gate.resolve();
  await Promise.all([held, behind]);
  assert.deepEqual(events, ["held:start", "behind:ran"]);
});

test("a signal that is already aborted takes nothing", async () => {
  const lease = new DevLease();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(lease.withLock("app/a", async () => "never", controller.signal), /aborted/);
});
