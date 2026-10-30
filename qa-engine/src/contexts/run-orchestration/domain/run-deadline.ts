/*
 * The deadline of one run, and the only clock that bounds it. Not armed until the run knows what kind of run it is (a diff run's
 * budget follows the size of its change, known only after classification); from then it counts down on the clock it was given.
 *
 * It allots time by purpose (kernel `DEADLINE_PURPOSES`): a purpose may spend what is left of the run less the reserve held for
 * the purposes that follow it. That reserve is the app's measured duration of those phases in its recent runs (`measure`); a
 * phase the app has no completed run of falls back to one shared reserve, a quarter of what is left and at least
 * `FALLBACK_RESERVE_MIN_MS`, and the allotment says so. Every consumer asks with its purpose and none keeps a reserve of its own.
 */
import { DEADLINE_PURPOSES, PHASES_OF_PURPOSE, purposeOfPhase, purposesAfter, type DeadlinePurpose } from "@kernel/deadline-purpose.ts";
import { RunDeadlineReached, type RunDeadlineView } from "@kernel/run-deadline.ts";
import { RUN_PHASES, type RunPhase } from "@kernel/run-step.ts";
import { runTimeBudgetKey, type RunTimeBudgets, type RunTimeBudgetScope } from "./run-time-budget.ts";

/* The share of the time left, and its floor, held back for the phases the app has no measurement of. */
export const FALLBACK_RESERVE_SHARE = 0.25;
export const FALLBACK_RESERVE_MIN_MS = 120_000;

/* The purposes that hold back only what the app measured of them, never the fallback: publication and the learning after it take seconds and the run does not cut them at the deadline (a run that kept its proven suite publishes after it), so a guess of a quarter of what is left would only take time from the review. */
const NO_FALLBACK: ReadonlySet<DeadlinePurpose> = new Set(["decide"]);

/* What a finished run recorded about its phases: the furthest one it entered and the milliseconds spent in each phase it entered. */
export interface PhaseRecord {
  furthestPhase: RunPhase | null;
  phaseTimings: Partial<Record<RunPhase, number>>;
  /** The purposes the run's deadline or a share of it cut: the time they took says how long the cut came, not how long the phases need. Absent: none, or the run recorded none. */
  cutPurposes?: readonly DeadlinePurpose[];
}

/* Where the reserve of an allotment came from: nothing is held back (no purpose follows, or only ones that hold back no guess), every following purpose that holds one was measured, or at least one was not and the fallback stands for them. */
export type ReserveSource = "none" | "measured" | "fallback";

export interface Reserve {
  ms: number;
  source: ReserveSource;
  /* The following purposes the app has no completed run of; they share the fallback. */
  unmeasured: readonly DeadlinePurpose[];
}

/* What a purpose may spend now and what was held back for the purposes after it. */
export interface Allotment {
  purpose: DeadlinePurpose;
  ms: number;
  reserve: Reserve;
}

export interface RunDeadlineDeps {
  /** The clock, in milliseconds. Injected so a test never waits for real time. */
  now: () => number;
  /** The time each kind of run is allowed, as the composition root resolved it. */
  budgets: RunTimeBudgets;
  /** Calls `fire` after `ms` and returns the call that cancels it. Absent: the system timer, which never keeps the process alive. A test passes one it fires by hand. */
  schedule?: (ms: number, fire: () => void) => () => void;
}

const systemSchedule = (ms: number, fire: () => void): (() => void) => {
  const handle = setTimeout(fire, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

/* A phase a run completed: one before its furthest, or the furthest itself when that is where a run normally ends. */
function completed(phase: RunPhase, furthest: RunPhase | null): boolean {
  if (furthest === null) return false;
  const at = RUN_PHASES.indexOf(phase);
  const end = RUN_PHASES.indexOf(furthest);
  return at < end || (at === end && (furthest === "learn" || furthest === "publish"));
}

/* The middle of the samples; the mean of the two in the middle for an even count. Deterministic: identical history gives identical reserves. */
function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.floor((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/*
 * The typical time each purpose took in the app's recent runs of one kind. A run is a sample of a purpose only when it entered one of
 * its phases, finished every phase of it that it entered and was not cut in it: a phase a run never entered (a run that failed before the
 * review) took no time for want of being run, which says nothing about how long it takes, and a cut phase says how long the cut came. A
 * purpose no run sampled is absent, and its reserve falls back, except one that no run of the history entered although runs with green
 * bytes finished whole (reached the end, cut nowhere, measured their coverage, which every run with green bytes does): runs of that kind
 * spend no time there (an app that does not review, a fix loop only a failing run enters), which is its measure, 0. Runs that never had
 * green bytes say nothing about what only green bytes reach: a streak of failing runs leaves the review and the coverage to the fallback.
 */
export function measuredPurposeDurations(records: readonly PhaseRecord[]): Map<DeadlinePurpose, number> {
  const measured = new Map<DeadlinePurpose, number>();
  const finishedWholeGreen = records.some((record) => (record.furthestPhase === "learn" || record.furthestPhase === "publish") && (record.cutPurposes?.length ?? 0) === 0 && PHASES_OF_PURPOSE.coverage.some((phase) => record.phaseTimings[phase] !== undefined));
  for (const purpose of DEADLINE_PURPOSES) {
    const samples: number[] = [];
    let anyEntered = false;
    for (const record of records) {
      const entered = PHASES_OF_PURPOSE[purpose].filter((phase) => record.phaseTimings[phase] !== undefined);
      if (entered.length > 0) anyEntered = true;
      if (entered.length === 0 || record.cutPurposes?.includes(purpose)) continue;
      if (!entered.every((phase) => completed(phase, record.furthestPhase))) continue;
      samples.push(entered.reduce((sum, phase) => sum + Math.max(0, record.phaseTimings[phase] ?? 0), 0));
    }
    if (samples.length > 0) measured.set(purpose, median(samples));
    else if (!anyEntered && finishedWholeGreen) measured.set(purpose, 0);
  }
  return measured;
}

export class RunDeadline implements RunDeadlineView {
  private armed: { label: string; budgetMs: number; deadlineAt: number; cut: AbortController; cancel: () => void } | undefined;
  private measured = new Map<DeadlinePurpose, number>();
  private current: DeadlinePurpose = "ground";
  private listener: ((allotment: Allotment) => void) | undefined;
  private readonly told = new Set<DeadlinePurpose>();

  constructor(private readonly deps: RunDeadlineDeps) {}

  /** Starts the countdown for this kind of run. Arming again restarts it for the new scope. */
  arm(scope: RunTimeBudgetScope): void {
    const label = runTimeBudgetKey(scope);
    const budgetMs = this.deps.budgets[label];
    this.armed?.cancel();
    const cut = new AbortController();
    const cancel = (this.deps.schedule ?? systemSchedule)(budgetMs, () => cut.abort(new RunDeadlineReached(label, budgetMs)));
    this.armed = { label, budgetMs, deadlineAt: this.deps.now() + budgetMs, cut, cancel };
    this.told.clear();
  }

  /** Hands in the app's recent finished runs: the reserve of every allotment is read from what they took. Without any, every reserve falls back. */
  measure(records: readonly PhaseRecord[]): void {
    this.measured = measuredPurposeDurations(records);
    this.told.clear();
  }

  /** The run entered a phase: an allowance asked for without a purpose is that phase's. */
  enter(phase: RunPhase): void {
    this.current = purposeOfPhase(phase);
  }

  /** Told the first time each purpose is allotted time after the deadline is armed (or re-measured): once per purpose, never once per turn. */
  observe(listener: (allotment: Allotment) => void): void {
    this.listener = listener;
  }

  /** Fires at the instant the run's time is spent; absent while no deadline is armed. What a deterministic phase is bounded by: it is cut here, not at its purpose's allowance, because the phases after it depend on what it proves. */
  signal(): AbortSignal | undefined {
    return this.armed?.cut.signal;
  }

  /** Whether the deadline's instant has been reached. */
  fired(): boolean {
    return this.armed?.cut.signal.aborted === true;
  }

  /** The purpose the run is in now. */
  currentPurpose(): DeadlinePurpose {
    return this.current;
  }

  remainingMs(): number | undefined {
    return this.armed ? this.armed.deadlineAt - this.deps.now() : undefined;
  }

  /** What is held back, at the moment of asking, for the purposes after `purpose`. */
  reserveAfter(purpose: DeadlinePurpose, left: number): Reserve {
    const later = purposesAfter(purpose);
    if (later.length === 0) return { ms: 0, source: "none", unmeasured: [] };
    const unmeasured = later.filter((p) => !this.measured.has(p) && !NO_FALLBACK.has(p));
    const measuredMs = later.reduce((sum, p) => sum + (this.measured.get(p) ?? 0), 0);
    if (unmeasured.length === 0) return { ms: measuredMs, source: later.some((p) => this.measured.has(p)) ? "measured" : "none", unmeasured };
    const fallbackMs = Math.max(FALLBACK_RESERVE_MIN_MS, Math.floor(Math.max(0, left) * FALLBACK_RESERVE_SHARE));
    return { ms: measuredMs + fallbackMs, source: "fallback", unmeasured };
  }

  /** The time `purpose` (default: the run's current one) may spend now, with the reserve it leaves; null while no deadline is armed. */
  allotment(purpose: DeadlinePurpose = this.current): Allotment | null {
    const left = this.remainingMs();
    if (left === undefined) return null;
    const reserve = this.reserveAfter(purpose, left);
    const allotment: Allotment = { purpose, ms: Math.max(0, left - reserve.ms), reserve };
    if (!this.told.has(purpose)) {
      this.told.add(purpose);
      try {
        this.listener?.(allotment);
      } catch {
        /* Observability never changes what a purpose is given. */
      }
    }
    return allotment;
  }

  /** What each purpose may still spend: the time left less the reserve held for the purposes after it. Null while no deadline is armed. */
  allowance(purpose?: DeadlinePurpose): number | null {
    return this.allotment(purpose)?.ms ?? null;
  }

  describe(): { label: string; budgetMs: number } | undefined {
    return this.armed ? { label: this.armed.label, budgetMs: this.armed.budgetMs } : undefined;
  }
}
