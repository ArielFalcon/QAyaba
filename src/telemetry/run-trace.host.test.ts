import { test } from "node:test";
import assert from "node:assert/strict";
import { RunTrace, markEnqueued, type RunIdentity } from "../server/run-trace";
import { HostListeners } from "./host-listeners";
import { traceHarness } from "./trace-harness";

const identity: RunIdentity = { runId: "r1", app: "shop", sha: "abc", mode: "diff", target: "e2e", trigger: "api" };
const facts = { verdict: "pass" as const, errorClass: null };

function open() {
  const h = traceHarness();
  const listeners = new HostListeners();
  const trace = new RunTrace(h.telemetry, h.clock, identity, markEnqueued(h.telemetry, h.clock, identity), listeners);
  return { h, listeners, trace };
}

test("a suspend while the run is active becomes a host_suspended event on the root and accumulates on it", () => {
  const { h, listeners, trace } = open();
  listeners.notify((l) => l.hostSuspended(32 * 60_000, h.clock.now()));
  listeners.notify((l) => l.hostSuspended(60_000, h.clock.now()));
  trace.finished(facts);
  trace.end();
  const root = h.only("qayaba.run");
  const events = root.events.filter((e) => e.name === "host_suspended");
  assert.equal(events.length, 2);
  assert.equal(events[0]!.attributes?.["qayaba.host.suspend_ms"], 32 * 60_000);
  assert.equal(root.attributes["qayaba.host.suspended_ms"], 33 * 60_000);
});

test("a blocked loop becomes an event_loop_blocked event, and the largest sampled delay lands on the root when it ends", () => {
  const { h, listeners, trace } = open();
  listeners.notify((l) => l.eventLoopObserved(40));
  listeners.notify((l) => l.eventLoopBlocked(2_500, h.clock.now()));
  listeners.notify((l) => l.eventLoopObserved(2_500));
  listeners.notify((l) => l.eventLoopObserved(90));
  trace.finished(facts);
  trace.end();
  const root = h.only("qayaba.run");
  const blocked = root.events.filter((e) => e.name === "event_loop_blocked");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.attributes?.["qayaba.host.blocked_ms"], 2_500);
  assert.equal(root.attributes["qayaba.host.event_loop.max_ms"], 2_500);
});

test("a run that saw no host event carries no host attribute", () => {
  const { h, trace } = open();
  trace.finished(facts);
  trace.end();
  const root = h.only("qayaba.run");
  assert.equal(root.attributes["qayaba.host.suspended_ms"], undefined);
  assert.equal(root.attributes["qayaba.host.event_loop.max_ms"], undefined);
});

test("the run registers for its length only: nothing is heard before it opens or after it ends", () => {
  const h = traceHarness();
  const listeners = new HostListeners();
  assert.equal(listeners.size(), 0);
  const trace = new RunTrace(h.telemetry, h.clock, identity, markEnqueued(h.telemetry, h.clock, identity), listeners);
  assert.equal(listeners.size(), 1);
  trace.end();
  assert.equal(listeners.size(), 0);
  listeners.notify((l) => l.hostSuspended(10_000, h.clock.now()));
  assert.deepEqual(h.only("qayaba.run").events.filter((e) => e.name === "host_suspended"), []);
});
