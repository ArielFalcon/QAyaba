/*
 * The right a run grants its generator to execute a spec it wrote, while it is still authoring (the `run_spec` tool).
 * Pure: counters, expiry and the ledger of what ran, with no clock of its own, no file and no process. A capability
 * belongs to one run, is bound to the sessions the orchestrator opened for the generator, and is revoked when the run
 * ends. Every limit is a count the orchestrator keeps, so a model cannot talk its way past one.
 */

import { DEFAULT_CLOSED_LOOP_LIMITS, type ClosedLoopLimits } from "@kernel/closed-loop.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";

/* The agent whose sessions hold the run's own capability. */
export const RUN_SPEC_AGENT = "qa-generator";

/* The agent whose sessions hold the capability of one flow of a plan: the sidekick that authors it. */
export const RUN_SPEC_FLOW_AGENT = "qa-sidekick";

/* Where the generator's throwaway specs live, relative to the spec directory. Nothing under it is ever delivered, stored or validated. */
export const PROBE_REL_DIR = ".qa-probe";

export type { ClosedLoopLimits };
export { DEFAULT_CLOSED_LOOP_LIMITS };

/* Less than this and a browser cannot start, log in and do anything worth reporting. */
export const MIN_CALL_MS = 10_000;

/* What a call leaves of the run's deadline for its own cleanup pass and for the turn that reads its answer. */
export const CLEANUP_RESERVE_MS = 15_000;

export const CLOSED_LOOP_REFUSAL = {
  REVOKED: "revoked",
  EXPIRED: "expired",
  UNKNOWN_SESSION: "unknown-session",
  WRONG_AGENT: "wrong-agent",
  NO_CALLS: "no-calls",
  NO_TIME: "no-time",
  NO_WRITES: "no-writes",
  BUSY: "busy",
} as const;

export type ClosedLoopRefusalCode = (typeof CLOSED_LOOP_REFUSAL)[keyof typeof CLOSED_LOOP_REFUSAL];

export interface ClosedLoopRefusal {
  ok: false;
  code: ClosedLoopRefusalCode;
  message: string;
}

export const RUN_SPEC_STATUS = {
  PASSED: "passed",
  FAILED: "failed",
  TIMED_OUT: "timedOut",
  ERROR: "error",
} as const;

export type RunSpecStatus = (typeof RUN_SPEC_STATUS)[keyof typeof RUN_SPEC_STATUS];

/* One call that ran: the spec's bytes at that moment (their sha256), how it ended, under which namespace, how long it took and how many writes it sent to DEV. */
export interface LedgerEntry {
  path: string;
  sha256: string;
  status: RunSpecStatus;
  namespace: string;
  ms: number;
  devWrites: number;
}

export interface CallBudget {
  callsLeft: number;
  msLeft: number | undefined;
  devWritesLeft: number;
}

export interface CallReservation {
  ok: true;
  callNumber: number;
  namespace: string;
  timeoutMs: number;
}

export interface RunSpecCapabilityInit {
  runId: string;
  limits: ClosedLoopLimits;
  expiresAtMs: number;
  now: () => number;
  /* The agents whose sessions may hold it. Absent: the generator alone. */
  agents?: ReadonlySet<string>;
}

function refuse(code: ClosedLoopRefusalCode, message: string): ClosedLoopRefusal {
  return { ok: false, code, message };
}

const DEFAULT_AGENTS: ReadonlySet<string> = new Set([RUN_SPEC_AGENT]);

export class RunSpecCapability {
  private readonly sessions = new Set<string>();
  private readonly entries: LedgerEntry[] = [];
  private revoked = false;
  private inFlight: { namespace: string } | undefined;
  private calls_ = 0;
  private devWrites_ = 0;

  constructor(private readonly init: RunSpecCapabilityInit) {}

  get runId(): string {
    return this.init.runId;
  }

  get limits(): ClosedLoopLimits {
    return this.init.limits;
  }

  get ledger(): readonly LedgerEntry[] {
    return this.entries;
  }

  /* The namespace of the call in flight, when one is: what an interrupted run must clean. */
  get pendingNamespace(): string | undefined {
    return this.inFlight?.namespace;
  }

  /* Calls that were started, refused ones excluded. */
  get calls(): number {
    return this.calls_;
  }

  /* Mutating requests the executed specs sent to DEV. */
  get devWrites(): number {
    return this.devWrites_;
  }

  bindSession(sessionId: string): void {
    this.sessions.add(sessionId);
  }

  unbindSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  revoke(): void {
    this.revoked = true;
  }

  /* Whether this session of this agent may call right now; the refusal says why not. */
  authorize(sessionId: string, agent: string): ClosedLoopRefusal | undefined {
    if (this.revoked) return refuse(CLOSED_LOOP_REFUSAL.REVOKED, "run_spec is no longer available: the run it belonged to has ended");
    if (this.init.now() >= this.init.expiresAtMs) return refuse(CLOSED_LOOP_REFUSAL.EXPIRED, "run_spec is no longer available: its time has run out");
    if (!this.sessions.has(sessionId)) return refuse(CLOSED_LOOP_REFUSAL.UNKNOWN_SESSION, "run_spec is not available to this session");
    if (!(this.init.agents ?? DEFAULT_AGENTS).has(agent)) return refuse(CLOSED_LOOP_REFUSAL.WRONG_AGENT, "run_spec is not available to this agent");
    return undefined;
  }

  /* What is left. `deadlineLeftMs` is the run's own deadline, when one is armed. */
  budget(deadlineLeftMs: number | undefined): CallBudget {
    return {
      callsLeft: Math.max(0, this.init.limits.maxCalls - this.calls_),
      msLeft: deadlineLeftMs === undefined ? undefined : Math.max(0, deadlineLeftMs),
      devWritesLeft: Math.max(0, this.init.limits.maxDevWrites - this.devWrites_),
    };
  }

  /* Takes one call from the budget, or says why there is none. The call it returns is the only one in flight until `settle`. */
  reserve(deadlineLeftMs: number | undefined): CallReservation | ClosedLoopRefusal {
    if (this.revoked) return refuse(CLOSED_LOOP_REFUSAL.REVOKED, "run_spec is no longer available: the run it belonged to has ended");
    if (this.inFlight) return refuse(CLOSED_LOOP_REFUSAL.BUSY, "another run_spec call is still running");
    if (this.calls_ >= this.init.limits.maxCalls) return refuse(CLOSED_LOOP_REFUSAL.NO_CALLS, `the ${this.init.limits.maxCalls} run_spec calls of this run are spent`);
    if (this.devWrites_ >= this.init.limits.maxDevWrites) return refuse(CLOSED_LOOP_REFUSAL.NO_WRITES, `the executed specs already sent ${this.devWrites_} write request(s) to DEV, the run's cap`);
    const timeoutMs = this.timeoutFor(deadlineLeftMs);
    if (typeof timeoutMs !== "number") return timeoutMs;
    this.calls_ += 1;
    const namespace = `${this.init.runId}-rs${this.calls_}`;
    this.inFlight = { namespace };
    return { ok: true, callNumber: this.calls_, namespace, timeoutMs };
  }

  /* The time a call that starts now may take given what the run's deadline has left, or why it may not start. A call that waited for the account asks again when it gets it: what it was told when it reserved is stale by then. */
  timeoutFor(deadlineLeftMs: number | undefined): number | ClosedLoopRefusal {
    const timeoutMs = deadlineLeftMs === undefined ? this.init.limits.perCallMs : Math.min(this.init.limits.perCallMs, deadlineLeftMs - CLEANUP_RESERVE_MS);
    return timeoutMs < MIN_CALL_MS ? refuse(CLOSED_LOOP_REFUSAL.NO_TIME, "the run has too little time left to execute a spec") : timeoutMs;
  }

  /* Gives back the call in flight when it never started (it was refused its turn, or its wait ended): nothing ran, so nothing is spent. */
  cancel(): void {
    if (!this.inFlight) throw new Error("run_spec cancel: no call is in flight");
    this.calls_ -= 1;
    this.inFlight = undefined;
  }

  /* Records how the reserved call ended. */
  settle(result: Omit<LedgerEntry, "namespace">): void {
    if (!this.inFlight) throw new Error("run_spec settle: no call is in flight");
    this.entries.push({ ...result, namespace: this.inFlight.namespace });
    this.devWrites_ += result.devWrites;
    this.inFlight = undefined;
  }
}

/*
 * Whether the generator saw every spec it delivered pass in the bytes it delivered: for each delivered spec, its last
 * ledger entry carries the spec's current sha256 and passed. `current` maps a delivered spec's path to the sha256 of what
 * is on disk now (undefined when the file is gone). Nothing delivered, or one spec that never ran, is not closed.
 */
export function loopClosed(ledger: readonly LedgerEntry[], current: ReadonlyMap<string, string | undefined>): boolean {
  if (current.size === 0) return false;
  const last = new Map<string, LedgerEntry>();
  for (const entry of ledger) last.set(normalizeSpecPath(entry.path), entry);
  for (const [path, sha256] of current) {
    const seen = last.get(normalizeSpecPath(path));
    if (sha256 === undefined || seen === undefined || seen.sha256 !== sha256 || seen.status !== RUN_SPEC_STATUS.PASSED) return false;
  }
  return true;
}
