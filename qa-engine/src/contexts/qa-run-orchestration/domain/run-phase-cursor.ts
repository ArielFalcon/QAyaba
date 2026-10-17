/*
 * Where a run is in its pipeline, and how long each stage took. A cursor is owned by one run: the use case enters a phase
 * at each boundary and closes the cursor however the run ends, so no exit path has to remember to end a phase and the
 * regions of the run need no wrapper. Time comes from the injected clock, never from the system.
 *
 * What the record means:
 * - A timing is the time spent inside a region of the run, not the pure cost of that phase. A review-round regeneration
 *   counts under review; coverage is a region only in diff mode (elsewhere its work is inside the phase before it); the
 *   reflect and audit of a terminal path count under whichever phase was open; a regression run that generates nothing
 *   still enters generate, because that is where the existing suite is run.
 * - learn is entered only on the mainline path, after the run's outcome is saved. A run that ends on a terminal exit
 *   (invalid, infra-error, deadline) keeps the phase it was in as its furthest, so the funnel reads where it stopped.
 * - A context run executes nothing and persists no outcome, so it ends at publish.
 * - Nothing here is stored in the run history of outcomes: the run's record holds it.
 */

/** The run's stages in pipeline order. The order decides which entered phase counts as the furthest one. */
export const RUN_PHASES = [
  "gate",
  "workspace",
  "classify",
  "setup",
  "ground",
  "generate",
  "validate",
  "health",
  "execute",
  "fix_loop",
  "coverage",
  "review",
  "decide",
  "publish",
  "learn",
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export interface PhaseClock {
  /** Wall-clock milliseconds. */
  now(): number;
}

/** What a run recorded about its phases: the milliseconds spent in each phase it entered and the furthest one. */
export interface PhaseSnapshot {
  furthestPhase: RunPhase | null;
  phaseTimings: Partial<Record<RunPhase, number>>;
}

/** Told when a phase opens and closes, with the clock reading the cursor itself took. A fault in an observer never reaches the cursor. */
export interface PhaseObserver {
  onEnter(phase: RunPhase, at: number): void;
  onExit(phase: RunPhase, at: number): void;
}

export class RunPhaseCursor {
  private readonly totals = new Map<RunPhase, number>();
  private open: { phase: RunPhase; since: number } | undefined;

  constructor(
    private readonly clock: PhaseClock,
    private readonly observer?: Partial<PhaseObserver>,
  ) {}

  /** Ends the open phase, if any, and opens `phase`. Entering a phase again adds to its total. */
  enter(phase: RunPhase): void {
    this.close();
    this.totals.set(phase, this.totals.get(phase) ?? 0);
    const since = this.clock.now();
    this.open = { phase, since };
    this.observe(() => this.observer?.onEnter?.(phase, since));
  }

  /** Ends the open phase. Safe to call when none is open. */
  close(): void {
    if (!this.open) return;
    const { phase, since } = this.open;
    this.open = undefined;
    const at = this.clock.now();
    this.totals.set(phase, (this.totals.get(phase) ?? 0) + (at - since));
    this.observe(() => this.observer?.onExit?.(phase, at));
  }

  /* Observability never changes how a run ends: an observer's fault is said and dropped. */
  private observe(notify: () => void): void {
    try {
      notify();
    } catch (err) {
      console.error(`[qa] a phase observer failed (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Milliseconds per entered phase; a phase still open counts the time it has run so far. */
  timings(): Partial<Record<RunPhase, number>> {
    const out: Partial<Record<RunPhase, number>> = {};
    for (const phase of RUN_PHASES) {
      const total = this.totals.get(phase);
      if (total === undefined) continue;
      out[phase] = this.open?.phase === phase ? total + (this.clock.now() - this.open.since) : total;
    }
    return out;
  }

  /** The entered phase latest in the pipeline, or null when none was entered. */
  furthest(): RunPhase | null {
    let furthest: RunPhase | null = null;
    for (const phase of RUN_PHASES) if (this.totals.has(phase)) furthest = phase;
    return furthest;
  }

  snapshot(): PhaseSnapshot {
    return { furthestPhase: this.furthest(), phaseTimings: this.timings() };
  }
}

const snapshotsOfErrors = new WeakMap<object, PhaseSnapshot>();

/** Remembers where a run stood when `err` ended it, so the caller that records the failure can read it without the error changing. */
export function recordPhaseSnapshot(err: unknown, snapshot: PhaseSnapshot): void {
  if (typeof err === "object" && err !== null) snapshotsOfErrors.set(err, snapshot);
}

export function phaseSnapshotOf(err: unknown): PhaseSnapshot | undefined {
  return typeof err === "object" && err !== null ? snapshotsOfErrors.get(err) : undefined;
}
