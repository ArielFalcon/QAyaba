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

test("a holder through the lock takes DEV exclusively: another account waits for it", async () => {
  const lease = new DevLease({ readOnlyEnforced: true });
  const gate = deferred();
  const events: string[] = [];
  const first = lease.withLock("app/a", async () => { events.push("a:start"); await gate.promise; events.push("a:end"); });
  const second = lease.withLock("app/b", async () => { events.push("b:start"); });
  await settle();
  assert.deepEqual(events, ["a:start"], "an action that may write is alone on DEV, whoever the account is");
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a:start", "a:end", "b:start"]);
});

test("read-only actions on distinct accounts run together when the proxy enforces read-only", async () => {
  const lease = new DevLease({ readOnlyEnforced: true });
  const gate = deferred();
  const events: string[] = [];
  const first = lease.withLease("app/a", { mayWrite: false }, async () => { events.push("a:start"); await gate.promise; events.push("a:end"); });
  const second = lease.withLease("app/b", { mayWrite: false }, async () => { events.push("b:start"); await gate.promise; });
  await settle();
  assert.deepEqual(events.sort(), ["a:start", "b:start"], "both hold DEV at once");
  gate.resolve();
  await Promise.all([first, second]);
});

test("read-only actions on one account are serialized", async () => {
  const lease = new DevLease({ readOnlyEnforced: true });
  const gate = deferred();
  const events: string[] = [];
  const first = lease.withLease("app/a", { mayWrite: false }, async () => { events.push("1:start"); await gate.promise; events.push("1:end"); });
  const second = lease.withLease("app/a", { mayWrite: false }, async () => { events.push("2:start"); });
  await settle();
  assert.deepEqual(events, ["1:start"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["1:start", "1:end", "2:start"]);
});

test("without a read-only guarantee a read-only claim is not believed: distinct accounts still do not overlap", async () => {
  const lease = new DevLease();
  const gate = deferred();
  const events: string[] = [];
  const first = lease.withLease("app/a", { mayWrite: false }, async () => { events.push("a:start"); await gate.promise; events.push("a:end"); });
  const second = lease.withLease("app/b", { mayWrite: false }, async () => { events.push("b:start"); });
  await settle();
  assert.deepEqual(events, ["a:start"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a:start", "a:end", "b:start"]);
});

test("an action that may write waits for the readers on other accounts, and readers that come after it queue behind it", async () => {
  const lease = new DevLease({ readOnlyEnforced: true });
  const readerGate = deferred();
  const writerGate = deferred();
  const events: string[] = [];
  const reader = lease.withLease("app/a", { mayWrite: false }, async () => { events.push("reader:start"); await readerGate.promise; events.push("reader:end"); });
  const writer = lease.withLease("app/b", { mayWrite: true }, async () => { events.push("writer:start"); await writerGate.promise; events.push("writer:end"); });
  const late = lease.withLease("app/c", { mayWrite: false }, async () => { events.push("late:start"); });
  await settle();
  assert.deepEqual(events, ["reader:start"], "the writer waits for the reader and the late reader does not slip past the writer");
  readerGate.resolve();
  await settle();
  assert.deepEqual(events, ["reader:start", "reader:end", "writer:start"]);
  writerGate.resolve();
  await Promise.all([reader, writer, late]);
  assert.deepEqual(events, ["reader:start", "reader:end", "writer:start", "writer:end", "late:start"]);
});

test("with one account every action is strictly serial, whatever it claims about writing", async () => {
  const lease = new DevLease({ readOnlyEnforced: true });
  let running = 0;
  let peak = 0;
  const hold = async (): Promise<void> => { running += 1; peak = Math.max(peak, running); await settle(); running -= 1; };
  await Promise.all([
    lease.withLease("app/a", { mayWrite: false }, hold),
    lease.withLease("app/a", { mayWrite: true }, hold),
    lease.withLease("app/a", { mayWrite: false }, hold),
    lease.withLock("app/a", hold),
  ]);
  assert.equal(peak, 1);
});

test("a holder that throws gives DEV back, so nothing waits behind it for good", async () => {
  const lease = new DevLease({ readOnlyEnforced: true });
  await assert.rejects(lease.withLease("app/a", { mayWrite: true }, async () => { throw new Error("boom"); }), /boom/);
  let ran = false;
  await lease.withLease("app/b", { mayWrite: true }, async () => { ran = true; });
  assert.equal(ran, true);
});

test("a waiter that gives up never holds DEV and does not hold up the ones behind it", async () => {
  const lease = new DevLease({ readOnlyEnforced: true });
  const gate = deferred();
  const events: string[] = [];
  const held = lease.withLease("app/a", { mayWrite: false }, async () => { events.push("held:start"); await gate.promise; });
  const controller = new AbortController();
  const gaveUp = lease.withLease("app/b", { mayWrite: true }, async () => { events.push("gave-up:ran"); }, controller.signal);
  const behind = lease.withLease("app/c", { mayWrite: false }, async () => { events.push("behind:ran"); });
  await settle();
  controller.abort();
  await assert.rejects(gaveUp, /aborted/);
  await behind;
  gate.resolve();
  await held;
  assert.deepEqual(events, ["held:start", "behind:ran"]);
});

test("a signal that is already aborted takes nothing", async () => {
  const lease = new DevLease({ readOnlyEnforced: true });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(lease.withLease("app/a", { mayWrite: false }, async () => "never", controller.signal), /aborted/);
});
