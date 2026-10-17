/* Process-wide host health (design §7, D9): what the machine does to the process, observed whether or not a run is active.

   Suspend versus blocked loop. A 5 s heartbeat compares the wall clock with a monotonic one between ticks.
   - Wall time moved more than monotonic time by over the threshold: the process was frozen (VM paused, laptop asleep) and wall time was corrected on resume. The duration is that gap. This rests on CLOCK_MONOTONIC not advancing while the guest is paused; inside Docker Desktop's VM that is unverified (spike S0.1).
   - The tick arrived late in monotonic time with no wall/monotonic gap: the event loop was blocked, not suspended.
   Limits. If the guest's monotonic clock advanced fully across a pause, a suspend cannot be told apart from a blocked loop (unverified on Docker Desktop, spike S0.1). A forward wall-clock step over the threshold (NTP, a manual change) reads as a suspend. The `qayaba.host.event_loop.max_ms` a run carries is window-granular: 10 s windows can include time just before the run began and miss the tail of its last window.
   Event-loop delay is read from `monitorEventLoopDelay` every 10 s and reset; a window whose max passes one second is a blocked loop too, unless the heartbeat already reported that stall.

   Sandbox zombies are counted from /proc (no child process): Z-state entries of the sandbox uid, every minute; where /proc cannot be read nothing is measured. The scan is synchronous and cheap in a container; its own cost shows in the event-loop delay metric.

   Everything is fail-open: a fault is counted, logged once, and never reaches a run or the server. Timers are unref'd so they never keep the process alive. Clocks, timers, the monitor, /proc and the telemetry port are injected, so tests need no real time. */

import { readdirSync, readFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { guardTelemetry } from "@kernel/telemetry/guarded-telemetry";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port";
import { hostListeners, type HostListeners } from "./host-listeners";

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const EVENT_LOOP_SAMPLE_INTERVAL_MS = 10_000;
export const ZOMBIE_SCAN_INTERVAL_MS = 60_000;
/* A wall/monotonic gap, or a late tick, beyond this is a suspend or a blocked loop; below it is clock noise and scheduling jitter. */
export const DEFAULT_THRESHOLD_MS = 2_000;
/* A sampled event-loop max beyond this is a blocked loop. */
export const EVENT_LOOP_BLOCKED_MS = 1_000;
const EVENT_LOOP_RESOLUTION_MS = 20;

/* Suspends last 2 s to hours; the semconv defaults stop near 10 s. */
export const SUSPEND_DURATION_BOUNDARIES_S = [2, 5, 15, 30, 60, 300, 900, 1800, 3600, 7200] as const;
export const EVENT_LOOP_DELAY_BOUNDARIES_MS = [1, 5, 10, 20, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;

export interface HostClocks {
  /* Wall-clock milliseconds (corrected when a suspended host resumes). */
  wallMs(): number;
  /* Monotonic milliseconds (does not advance while the process or its VM is frozen). */
  monoMs(): number;
}

export interface HostScheduler {
  every(ms: number, fn: () => void): { stop(): void };
}

/* The part of perf_hooks' IntervalHistogram that is used. Values are nanoseconds. */
export interface EventLoopMonitor {
  enable(): void;
  disable(): void;
  reset(): void;
  percentile(p: number): number;
  readonly max: number;
}

export interface ProcFs {
  /* Process ids, or undefined when /proc cannot be listed. */
  pids(): string[] | undefined;
  /* The text of /proc/<pid>/status, or undefined when the process is gone or unreadable. */
  status(pid: string): string | undefined;
}

/* What GET /api/v1/telemetry/health reports under `host`. */
export interface HostHealthSnapshot {
  suspends: number;
  lastSuspendAt?: string;
  lastSuspendMs?: number;
  blockedLoops: number;
  eventLoopP99Ms?: number;
  zombies?: number;
}

export interface HostHealthDeps {
  readonly telemetry: TelemetryPort;
  readonly listeners?: HostListeners;
  readonly clocks?: HostClocks;
  readonly scheduler?: HostScheduler;
  readonly monitor?: EventLoopMonitor;
  /* Builds the monitor lazily, inside start()'s fault boundary. Default: perf_hooks' monitorEventLoopDelay. */
  readonly createMonitor?: () => EventLoopMonitor;
  readonly proc?: ProcFs;
  /* The sandbox uid whose zombies are counted. Absent: no zombie measurement. */
  readonly sandboxUid?: number;
  readonly thresholdMs?: number;
  /* Where the single fault line goes. Default: console.error. */
  readonly log?: (line: string) => void;
}

export const systemClocks: HostClocks = {
  wallMs: () => Date.now(),
  monoMs: () => Number(process.hrtime.bigint()) / 1e6,
};

export const systemScheduler: HostScheduler = {
  every(ms, fn) {
    const timer = setInterval(fn, ms);
    timer.unref();
    return { stop: () => clearInterval(timer) };
  },
};

export const systemProcFs: ProcFs = {
  pids() {
    try {
      return readdirSync("/proc").filter((name) => /^\d+$/.test(name));
    } catch {
      return undefined;
    }
  },
  status(pid) {
    try {
      return readFileSync(`/proc/${pid}/status`, "utf8");
    } catch {
      return undefined;
    }
  },
};

function systemMonitor(): EventLoopMonitor {
  return monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
}

/* The zombies (state Z) of one uid, or undefined when /proc cannot be listed. A process that vanishes or reads oddly between the listing and the read is skipped. */
export function countSandboxZombies(proc: ProcFs, uid: number): number | undefined {
  let pids: string[] | undefined;
  try {
    pids = proc.pids();
  } catch {
    return undefined;
  }
  if (pids === undefined) return undefined;
  let zombies = 0;
  for (const pid of pids) {
    let text: string | undefined;
    try {
      text = proc.status(pid);
    } catch {
      continue;
    }
    if (text === undefined) continue;
    const state = /^State:\s*(\S)/m.exec(text)?.[1];
    const owner = /^Uid:\s*(\d+)/m.exec(text)?.[1];
    if (state === "Z" && owner !== undefined && Number(owner) === uid) zombies += 1;
  }
  return zombies;
}

const nsToMs = (ns: number): number => (Number.isFinite(ns) ? ns / 1e6 : 0);

export class HostHealth {
  private readonly telemetry: TelemetryPort;
  private readonly listeners: HostListeners;
  private readonly clocks: HostClocks;
  private readonly scheduler: HostScheduler;
  private monitor: EventLoopMonitor | undefined;
  private readonly proc: ProcFs;
  private readonly thresholdMs: number;
  private readonly log: (line: string) => void;
  private timers: Array<{ stop(): void }> = [];
  private lastWall = 0;
  private lastMono = 0;
  private suspends = 0;
  private lastSuspendAt: string | undefined;
  private lastSuspendMs: number | undefined;
  private blockedLoops = 0;
  private eventLoopP99Ms: number | undefined;
  private zombies: number | undefined;
  private blockedReportedInWindow = false;
  private faults = 0;

  constructor(private readonly deps: HostHealthDeps) {
    this.telemetry = guardTelemetry(deps.telemetry);
    this.listeners = deps.listeners ?? hostListeners;
    this.clocks = deps.clocks ?? systemClocks;
    this.scheduler = deps.scheduler ?? systemScheduler;
    this.monitor = deps.monitor;
    this.proc = deps.proc ?? systemProcFs;
    this.thresholdMs = deps.thresholdMs ?? DEFAULT_THRESHOLD_MS;
    this.log = deps.log ?? ((line) => console.error(line));
  }

  start(): void {
    if (this.timers.length > 0) return;
    this.guarded("start", () => {
      this.lastWall = this.clocks.wallMs();
      this.lastMono = this.clocks.monoMs();
    });
    this.guarded("monitor", () => {
      this.monitor ??= (this.deps.createMonitor ?? systemMonitor)();
      this.monitor.enable();
    });
    this.timers.push(this.scheduler.every(HEARTBEAT_INTERVAL_MS, () => this.guarded("heartbeat", () => this.heartbeat())));
    this.timers.push(this.scheduler.every(EVENT_LOOP_SAMPLE_INTERVAL_MS, () => this.guarded("event-loop sample", () => this.sampleEventLoop())));
    if (this.deps.sandboxUid !== undefined) {
      this.timers.push(this.scheduler.every(ZOMBIE_SCAN_INTERVAL_MS, () => this.guarded("zombie scan", () => this.scanZombies())));
      this.guarded("zombie scan", () => this.scanZombies());
    }
  }

  stop(): void {
    for (const timer of this.timers) this.guarded("stop", () => timer.stop());
    this.timers = [];
    this.blockedReportedInWindow = false;
    this.guarded("monitor", () => this.monitor?.disable());
  }

  snapshot(): HostHealthSnapshot {
    return {
      suspends: this.suspends,
      ...(this.lastSuspendAt !== undefined ? { lastSuspendAt: this.lastSuspendAt } : {}),
      ...(this.lastSuspendMs !== undefined ? { lastSuspendMs: this.lastSuspendMs } : {}),
      blockedLoops: this.blockedLoops,
      ...(this.eventLoopP99Ms !== undefined ? { eventLoopP99Ms: this.eventLoopP99Ms } : {}),
      ...(this.zombies !== undefined ? { zombies: this.zombies } : {}),
    };
  }

  private heartbeat(): void {
    const wall = this.clocks.wallMs();
    const mono = this.clocks.monoMs();
    const dWall = wall - this.lastWall;
    const dMono = mono - this.lastMono;
    this.lastWall = wall;
    this.lastMono = mono;
    const frozenMs = dWall - dMono;
    const lateMs = dMono - HEARTBEAT_INTERVAL_MS;
    if (frozenMs > this.thresholdMs) this.suspended(frozenMs, wall);
    else if (lateMs > this.thresholdMs) this.blocked(lateMs, wall, true);
  }

  private suspended(ms: number, at: number): void {
    this.suspends += 1;
    this.lastSuspendAt = new Date(at).toISOString();
    this.lastSuspendMs = ms;
    /* The sample of this window will show the same stall; it is not a second one. */
    this.blockedReportedInWindow = true;
    this.telemetry.counter("qayaba.host.suspend.count")(1);
    this.telemetry.histogram("qayaba.host.suspend.duration")(ms / 1000);
    this.listeners.notify((l) => l.hostSuspended(ms, at));
  }

  private blocked(ms: number, at: number, fromHeartbeat: boolean): void {
    this.blockedLoops += 1;
    if (fromHeartbeat) this.blockedReportedInWindow = true;
    this.telemetry.counter("qayaba.host.event_loop.blocked")(1);
    this.listeners.notify((l) => l.eventLoopBlocked(ms, at));
  }

  private sampleEventLoop(): void {
    const monitor = this.monitor;
    if (monitor === undefined) return;
    const p50 = nsToMs(monitor.percentile(50));
    const p99 = nsToMs(monitor.percentile(99));
    const max = nsToMs(monitor.max);
    monitor.reset();
    const alreadyReported = this.blockedReportedInWindow;
    this.blockedReportedInWindow = false;
    this.eventLoopP99Ms = p99;
    const delay = this.telemetry.histogram("qayaba.host.event_loop.delay");
    delay(p50, { "qayaba.event_loop.stat": "p50" });
    delay(p99, { "qayaba.event_loop.stat": "p99" });
    delay(max, { "qayaba.event_loop.stat": "max" });
    this.listeners.notify((l) => l.eventLoopObserved(max));
    if (max > EVENT_LOOP_BLOCKED_MS && !alreadyReported) this.blocked(max, this.clocks.wallMs(), false);
  }

  private scanZombies(): void {
    const uid = this.deps.sandboxUid;
    if (uid === undefined) return;
    const count = countSandboxZombies(this.proc, uid);
    this.zombies = count;
    if (count !== undefined) this.telemetry.gauge("qayaba.sandbox.zombies")(count);
  }

  /* One fault boundary for every timer callback: counted, logged once, never thrown. */
  private guarded(where: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.faults += 1;
      if (this.faults === 1) {
        try {
          this.log(`[host-health] ${where} failed (further faults are counted, not logged): ${error instanceof Error ? error.message : String(error)}`);
        } catch {
          /* a failing logger is not a reason to throw */
        }
      }
    }
  }
}
