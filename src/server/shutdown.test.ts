import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installShutdown, installUnhandledRejectionRecorder, type ShutdownDeps } from "./shutdown";

function setup(over: { drain?: () => Promise<void>; drainMs?: number } = {}) {
  const calls: string[] = [];
  const exits: number[] = [];
  const logs: string[] = [];
  const signals = new EventEmitter();
  const deps: ShutdownDeps = {
    queue: {
      cancel: () => calls.push("cancel"),
      drain: over.drain ?? (async () => { calls.push("drain"); }),
    },
    telemetry: { flush: () => calls.push("flush"), shutdown: async () => { calls.push("telemetry.shutdown"); } },
    hostHealth: { stop: () => calls.push("hostHealth.stop") },
    eventStream: { abort: () => calls.push("eventStream.abort") },
    drainMs: over.drainMs ?? 1_000,
    telemetryShutdownMs: 5,
    exit: (code) => exits.push(code),
    log: (message) => logs.push(message),
  };
  const lifecycle = installShutdown(deps, signals);
  return { lifecycle, signals, calls, exits, logs };
}

test("SIGTERM cancels the in-flight job, waits for the drain, shuts telemetry down once and exits 0", async () => {
  const { lifecycle, signals, calls, exits } = setup();
  signals.emit("SIGTERM");
  await lifecycle.shutdown("SIGTERM");
  assert.deepEqual(exits, [0]);
  assert.equal(calls.filter((call) => call === "telemetry.shutdown").length, 1);
  assert.ok(calls.indexOf("cancel") < calls.indexOf("telemetry.shutdown"), "the job is cancelled before telemetry stops");
  assert.ok(calls.includes("hostHealth.stop") && calls.includes("eventStream.abort"));
  assert.ok(!calls.includes("flush"), "the forced-exit flush runs only when the drain times out");
});

test("a drain that outlives its window flushes the span ledger and exits 1", async () => {
  const { lifecycle, calls, exits } = setup({ drain: () => new Promise<void>(() => {}), drainMs: 10 });
  await lifecycle.shutdown("SIGINT");
  assert.deepEqual(exits, [1]);
  assert.ok(calls.includes("flush"));
  assert.ok(!calls.includes("telemetry.shutdown"));
});

test("the lifecycle refuses new work from the first signal and while a hot swap marked it", async () => {
  const { lifecycle } = setup();
  assert.equal(lifecycle.shuttingDown(), false);
  lifecycle.setShuttingDown(true);
  assert.equal(lifecycle.shuttingDown(), true);
  lifecycle.setShuttingDown(false);
  const done = lifecycle.shutdown("SIGTERM");
  assert.equal(lifecycle.shuttingDown(), true);
  await done;
});

test("a second signal joins the shutdown in progress instead of starting another", async () => {
  const { lifecycle, signals, exits, calls } = setup();
  signals.emit("SIGTERM");
  signals.emit("SIGINT");
  await lifecycle.shutdown("SIGTERM");
  assert.deepEqual(exits, [0]);
  assert.equal(calls.filter((call) => call === "cancel").length, 1);
});

test("the signal that arrived is named in the log line", async () => {
  const { lifecycle, logs } = setup();
  await lifecycle.shutdown("SIGINT");
  assert.ok(logs.some((line) => line.includes("SIGINT")));
});

test("an unhandled rejection is logged and recorded as an incident", () => {
  const source = new EventEmitter();
  const recorded: string[] = [];
  const logged: string[] = [];
  installUnhandledRejectionRecorder((summary) => recorded.push(summary), (message) => logged.push(message), source as never);
  source.emit("unhandledRejection", new Error("boom"));
  assert.ok(recorded[0]?.includes("boom"));
  assert.ok(logged[0]?.includes("boom"));
});
