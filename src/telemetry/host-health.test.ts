import { test } from "node:test";
import assert from "node:assert/strict";
import { ThrowingTelemetry } from "@kernel/telemetry/guarded-telemetry";
import { HostHealth, countSandboxZombies, SUSPEND_DURATION_BOUNDARIES_S, EVENT_LOOP_DELAY_BOUNDARIES_MS, type EventLoopMonitor, type HostScheduler, type ProcFs } from "./host-health";
import { HostListeners, type HostEventListener } from "./host-listeners";
import { traceHarness } from "./trace-harness";

const HEARTBEAT_MS = 5_000;
const SAMPLE_MS = 10_000;
const ZOMBIE_MS = 60_000;

class FakeScheduler implements HostScheduler {
  readonly timers = new Map<number, () => void>();
  stopped = 0;
  every(ms: number, fn: () => void): { stop(): void } {
    this.timers.set(ms, fn);
    return { stop: () => void (this.stopped += 1, this.timers.delete(ms)) };
  }
  fire(ms: number): void {
    const fn = this.timers.get(ms);
    if (!fn) throw new Error(`no timer at ${ms}`);
    fn();
  }
}

class FakeClocks {
  wall = 1_760_000_000_000;
  mono = 5_000_000;
  /* Time that passes for both clocks. */
  tick(ms: number): void {
    this.wall += ms;
    this.mono += ms;
  }
  /* Time the process did not see: wall moves, monotonic does not. */
  freeze(ms: number): void {
    this.wall += ms;
  }
  /* Time the process lived through but could not use: both move, the tick is late. */
  block(ms: number): void {
    this.tick(ms);
  }
  api = { wallMs: () => this.wall, monoMs: () => this.mono };
}

class FakeMonitor implements EventLoopMonitor {
  enabled = false;
  resets = 0;
  p50 = 0;
  p99 = 0;
  max = 0;
  enable(): void {
    this.enabled = true;
  }
  disable(): void {
    this.enabled = false;
  }
  reset(): void {
    this.resets += 1;
  }
  percentile(p: number): number {
    return p >= 99 ? this.p99 : this.p50;
  }
}

const NS = 1e6;

function procOf(entries: Record<string, string | undefined> | undefined): ProcFs {
  return {
    pids: () => (entries ? Object.keys(entries) : undefined),
    status: (pid) => entries?.[pid],
  };
}
const status = (state: string, uid: number): string => `Name:\tx\nState:\t${state} (word)\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;

function setup(opts: { telemetry?: import("@kernel/telemetry/telemetry.port").TelemetryPort; proc?: ProcFs; sandboxUid?: number } = {}) {
  const h = traceHarness();
  const clocks = new FakeClocks();
  const scheduler = new FakeScheduler();
  const monitor = new FakeMonitor();
  const listeners = new HostListeners();
  const host = new HostHealth({
    telemetry: opts.telemetry ?? h.telemetry,
    listeners,
    clocks: clocks.api,
    scheduler,
    monitor,
    ...(opts.proc ? { proc: opts.proc } : {}),
    ...(opts.sandboxUid !== undefined ? { sandboxUid: opts.sandboxUid } : {}),
  });
  host.start();
  return { h, clocks, scheduler, monitor, listeners, host };
}

const measured = (h: ReturnType<typeof traceHarness>, name: string) => h.measurements.filter((m) => m.name === name);

interface Seen {
  suspended: Array<{ ms: number; at: number }>;
  blocked: Array<{ ms: number; at: number }>;
  observed: number[];
}
function recorder(): { listener: HostEventListener; seen: Seen } {
  const seen: Seen = { suspended: [], blocked: [], observed: [] };
  return {
    seen,
    listener: {
      hostSuspended: (ms, at) => void seen.suspended.push({ ms, at }),
      eventLoopBlocked: (ms, at) => void seen.blocked.push({ ms, at }),
      eventLoopObserved: (maxMs) => void seen.observed.push(maxMs),
    },
  };
}

test("normal heartbeats report nothing", () => {
  const { h, clocks, scheduler, listeners, host } = setup();
  const { listener, seen } = recorder();
  listeners.add(listener);
  for (let i = 0; i < 6; i += 1) {
    clocks.tick(HEARTBEAT_MS + 40);
    scheduler.fire(HEARTBEAT_MS);
  }
  assert.deepEqual(seen.suspended, []);
  assert.deepEqual(seen.blocked, []);
  assert.deepEqual(h.measurements, []);
  assert.equal(host.snapshot().suspends, 0);
  assert.equal(host.snapshot().blockedLoops, 0);
});

test("a wall jump of 32 minutes with a flat monotonic clock is one suspend of about 32 minutes", () => {
  const { h, clocks, scheduler, listeners, host } = setup();
  const { listener, seen } = recorder();
  listeners.add(listener);
  clocks.tick(HEARTBEAT_MS);
  clocks.freeze(32 * 60_000);
  scheduler.fire(HEARTBEAT_MS);
  assert.equal(seen.suspended.length, 1);
  assert.equal(seen.suspended[0]!.ms, 32 * 60_000);
  assert.equal(seen.suspended[0]!.at, clocks.wall);
  assert.deepEqual(seen.blocked, []);
  assert.deepEqual(measured(h, "qayaba.host.suspend.count").map((m) => m.value), [1]);
  assert.deepEqual(measured(h, "qayaba.host.suspend.duration").map((m) => m.value), [32 * 60]);
  assert.deepEqual(measured(h, "qayaba.host.event_loop.blocked"), []);
  const snap = host.snapshot();
  assert.equal(snap.suspends, 1);
  assert.equal(snap.lastSuspendMs, 32 * 60_000);
  assert.equal(snap.lastSuspendAt, new Date(clocks.wall).toISOString());
  /* The next normal tick is not a second suspend. */
  clocks.tick(HEARTBEAT_MS);
  scheduler.fire(HEARTBEAT_MS);
  assert.equal(host.snapshot().suspends, 1);
});

test("a gap under the threshold is clock noise, not a suspend", () => {
  const { clocks, scheduler, host } = setup();
  clocks.tick(HEARTBEAT_MS);
  clocks.freeze(1_500);
  scheduler.fire(HEARTBEAT_MS);
  assert.equal(host.snapshot().suspends, 0);
});

test("a wall clock that steps backwards is ignored", () => {
  const { clocks, scheduler, host } = setup();
  clocks.tick(HEARTBEAT_MS);
  clocks.freeze(-60_000);
  scheduler.fire(HEARTBEAT_MS);
  assert.equal(host.snapshot().suspends, 0);
  assert.equal(host.snapshot().blockedLoops, 0);
});

test("a tick that arrives late in monotonic time with no wall gap is a blocked loop, not a suspend", () => {
  const { h, clocks, scheduler, listeners, host } = setup();
  const { listener, seen } = recorder();
  listeners.add(listener);
  clocks.block(HEARTBEAT_MS + 7_000);
  scheduler.fire(HEARTBEAT_MS);
  assert.deepEqual(seen.suspended, []);
  assert.equal(seen.blocked.length, 1);
  assert.equal(seen.blocked[0]!.ms, 7_000);
  assert.deepEqual(measured(h, "qayaba.host.suspend.count"), []);
  assert.deepEqual(measured(h, "qayaba.host.event_loop.blocked").map((m) => m.value), [1]);
  assert.equal(host.snapshot().blockedLoops, 1);
  assert.equal(host.snapshot().suspends, 0);
});

test("event-loop delay is sampled in milliseconds, recorded as p50, p99 and max, then reset", () => {
  const { h, scheduler, monitor, listeners } = setup();
  const { listener, seen } = recorder();
  listeners.add(listener);
  monitor.p50 = 21 * NS;
  monitor.p99 = 180 * NS;
  monitor.max = 400 * NS;
  scheduler.fire(SAMPLE_MS);
  const delay = measured(h, "qayaba.host.event_loop.delay");
  assert.deepEqual(
    delay.map((m) => [m.attrs["qayaba.event_loop.stat"], m.value]),
    [["p50", 21], ["p99", 180], ["max", 400]],
  );
  assert.equal(monitor.resets, 1);
  assert.deepEqual(seen.observed, [400]);
  assert.deepEqual(seen.blocked, []);
  assert.deepEqual(measured(h, "qayaba.host.event_loop.blocked"), []);
});

test("a sampled max above one second is a blocked loop on the active run", () => {
  const { h, scheduler, monitor, listeners, host } = setup();
  const { listener, seen } = recorder();
  listeners.add(listener);
  monitor.max = 1_800 * NS;
  scheduler.fire(SAMPLE_MS);
  assert.equal(seen.blocked.length, 1);
  assert.equal(seen.blocked[0]!.ms, 1_800);
  assert.deepEqual(measured(h, "qayaba.host.event_loop.blocked").map((m) => m.value), [1]);
  assert.equal(host.snapshot().blockedLoops, 1);
  assert.equal(host.snapshot().eventLoopP99Ms, 0);
});

test("a stall the heartbeat already reported is not counted a second time by the sample", () => {
  const { h, clocks, scheduler, monitor, host } = setup();
  clocks.block(HEARTBEAT_MS + 4_000);
  scheduler.fire(HEARTBEAT_MS);
  monitor.max = 4_000 * NS;
  scheduler.fire(SAMPLE_MS);
  assert.equal(host.snapshot().blockedLoops, 1);
  assert.deepEqual(measured(h, "qayaba.host.event_loop.blocked").map((m) => m.value), [1]);
  /* The next window is judged afresh. */
  monitor.max = 1_500 * NS;
  scheduler.fire(SAMPLE_MS);
  assert.equal(host.snapshot().blockedLoops, 2);
});

test("the snapshot carries the last sampled p99", () => {
  const { scheduler, monitor, host } = setup();
  assert.equal(host.snapshot().eventLoopP99Ms, undefined);
  monitor.p99 = 90 * NS;
  scheduler.fire(SAMPLE_MS);
  assert.equal(host.snapshot().eventLoopP99Ms, 90);
});

test("every registered listener hears an event, and one that throws does not silence the others", () => {
  const { clocks, scheduler, listeners, host } = setup();
  listeners.add({
    hostSuspended: () => {
      throw new Error("listener exploded");
    },
    eventLoopBlocked: () => {},
    eventLoopObserved: () => {},
  });
  const { listener, seen } = recorder();
  listeners.add(listener);
  clocks.tick(HEARTBEAT_MS);
  clocks.freeze(10_000);
  assert.doesNotThrow(() => scheduler.fire(HEARTBEAT_MS));
  assert.equal(seen.suspended.length, 1);
  assert.equal(host.snapshot().suspends, 1);
});

test("a removed listener hears nothing", () => {
  const { clocks, scheduler, listeners } = setup();
  const { listener, seen } = recorder();
  const remove = listeners.add(listener);
  remove();
  remove();
  clocks.freeze(10_000);
  scheduler.fire(HEARTBEAT_MS);
  assert.deepEqual(seen.suspended, []);
});

test("sandbox zombies count Z-state processes of the sandbox uid only", () => {
  const proc = procOf({
    "10": status("Z", 1001),
    "11": status("Z", 1001),
    "12": status("S", 1001),
    "13": status("Z", 0),
    "14": status("R", 0),
    "15": undefined,
    "16": "garbage",
  });
  assert.equal(countSandboxZombies(proc, 1001), 2);
  assert.equal(countSandboxZombies(proc, 0), 1);
  assert.equal(countSandboxZombies(procOf({}), 1001), 0);
});

test("an unreadable /proc yields no count", () => {
  assert.equal(countSandboxZombies(procOf(undefined), 1001), undefined);
  assert.equal(countSandboxZombies({ pids: () => { throw new Error("EACCES"); }, status: () => undefined }, 1001), undefined);
});

test("the zombie gauge is measured every minute and shows in the snapshot", () => {
  const entries: Record<string, string> = { "10": status("Z", 1001) };
  const { h, scheduler, host } = setup({ proc: procOf(entries), sandboxUid: 1001 });
  assert.deepEqual(measured(h, "qayaba.sandbox.zombies").map((m) => m.value), [1]);
  entries["11"] = status("Z", 1001);
  scheduler.fire(ZOMBIE_MS);
  assert.deepEqual(measured(h, "qayaba.sandbox.zombies").map((m) => m.value), [1, 2]);
  assert.equal(host.snapshot().zombies, 2);
});

test("with no sandbox uid there is no zombie timer and no gauge", () => {
  const { h, scheduler, host } = setup({ proc: procOf({ "10": status("Z", 1001) }) });
  assert.equal(scheduler.timers.has(ZOMBIE_MS), false);
  assert.deepEqual(measured(h, "qayaba.sandbox.zombies"), []);
  assert.equal(host.snapshot().zombies, undefined);
});

test("an unreadable /proc records no gauge, keeps the last known count out of the snapshot and does not throw", () => {
  let readable = true;
  const proc: ProcFs = { pids: () => (readable ? ["10"] : undefined), status: () => status("Z", 1001) };
  const { h, scheduler, host } = setup({ proc, sandboxUid: 1001 });
  assert.equal(host.snapshot().zombies, 1);
  readable = false;
  assert.doesNotThrow(() => scheduler.fire(ZOMBIE_MS));
  assert.deepEqual(measured(h, "qayaba.sandbox.zombies").map((m) => m.value), [1]);
  assert.equal(host.snapshot().zombies, undefined);
});

test("a telemetry port that throws everywhere never reaches the host or its state", () => {
  const { clocks, scheduler, monitor, host } = setup({ telemetry: new ThrowingTelemetry(), proc: procOf({ "10": status("Z", 1) }), sandboxUid: 1 });
  monitor.max = 3_000 * NS;
  assert.doesNotThrow(() => scheduler.fire(SAMPLE_MS));
  clocks.tick(HEARTBEAT_MS);
  clocks.freeze(60_000);
  assert.doesNotThrow(() => scheduler.fire(HEARTBEAT_MS));
  assert.doesNotThrow(() => scheduler.fire(ZOMBIE_MS));
  assert.equal(host.snapshot().suspends, 1);
  assert.equal(host.snapshot().blockedLoops, 1);
  assert.equal(host.snapshot().zombies, 1);
});

test("a fault inside a tick is logged once and the heartbeat keeps running", () => {
  const logged: string[] = [];
  const h = traceHarness();
  const clocks = new FakeClocks();
  const scheduler = new FakeScheduler();
  const host = new HostHealth({
    telemetry: h.telemetry,
    listeners: new HostListeners(),
    clocks: { wallMs: () => { throw new Error("clock exploded"); }, monoMs: clocks.api.monoMs },
    scheduler,
    monitor: new FakeMonitor(),
    log: (line) => void logged.push(line),
  });
  assert.doesNotThrow(() => host.start());
  assert.doesNotThrow(() => scheduler.fire(HEARTBEAT_MS));
  assert.doesNotThrow(() => scheduler.fire(HEARTBEAT_MS));
  assert.doesNotThrow(() => scheduler.fire(SAMPLE_MS));
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /clock exploded/);
});

test("stop clears the timers and the monitor, and is idempotent; start twice does not double the timers", () => {
  const { scheduler, monitor, host } = setup();
  assert.equal(monitor.enabled, true);
  host.start();
  assert.equal(scheduler.timers.size, 2);
  host.stop();
  host.stop();
  assert.equal(monitor.enabled, false);
  assert.equal(scheduler.timers.size, 0);
});

test("the suspend histogram buckets cover two seconds to two hours; the delay buckets cover one millisecond to ten seconds", () => {
  const ascending = (xs: readonly number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]!);
  assert.ok(ascending(SUSPEND_DURATION_BOUNDARIES_S));
  assert.ok(SUSPEND_DURATION_BOUNDARIES_S[0]! <= 2);
  assert.ok(SUSPEND_DURATION_BOUNDARIES_S.at(-1)! >= 7_200);
  assert.ok(ascending(EVENT_LOOP_DELAY_BOUNDARIES_MS));
  assert.ok(EVENT_LOOP_DELAY_BOUNDARIES_MS[0]! <= 1);
  assert.ok(EVENT_LOOP_DELAY_BOUNDARIES_MS.at(-1)! >= 10_000);
});

test("a suspend tick followed by a sampled max above one second is one suspend and no blocked loop", () => {
  const { h, clocks, scheduler, monitor, host } = setup();
  clocks.tick(HEARTBEAT_MS);
  clocks.freeze(30_000);
  scheduler.fire(HEARTBEAT_MS);
  monitor.max = 5_000 * NS;
  scheduler.fire(SAMPLE_MS);
  assert.equal(host.snapshot().suspends, 1);
  assert.equal(host.snapshot().blockedLoops, 0);
  assert.deepEqual(measured(h, "qayaba.host.event_loop.blocked"), []);
});

test("stop forgets a stall the heartbeat reported, so a restarted host judges its first window afresh", () => {
  const { clocks, scheduler, monitor, host } = setup();
  clocks.block(HEARTBEAT_MS + 4_000);
  scheduler.fire(HEARTBEAT_MS);
  assert.equal(host.snapshot().blockedLoops, 1);
  host.stop();
  host.start();
  monitor.max = 2_000 * NS;
  scheduler.fire(SAMPLE_MS);
  assert.equal(host.snapshot().blockedLoops, 2);
});

test("a monitor that cannot be built never aborts construction or start, and the heartbeat still works", () => {
  const h = traceHarness();
  const clocks = new FakeClocks();
  const scheduler = new FakeScheduler();
  const logged: string[] = [];
  let host!: HostHealth;
  assert.doesNotThrow(() => {
    host = new HostHealth({
      telemetry: h.telemetry,
      listeners: new HostListeners(),
      clocks: clocks.api,
      scheduler,
      createMonitor: () => {
        throw new Error("perf_hooks exploded");
      },
      log: (line) => void logged.push(line),
    });
    host.start();
  });
  assert.doesNotThrow(() => scheduler.fire(SAMPLE_MS));
  clocks.tick(HEARTBEAT_MS);
  clocks.freeze(10_000);
  scheduler.fire(HEARTBEAT_MS);
  assert.equal(host.snapshot().suspends, 1);
  assert.doesNotThrow(() => host.stop());
  assert.equal(logged.length, 1);
});
