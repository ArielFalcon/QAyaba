import type { DeadlinePurpose } from "@kernel/deadline-purpose.ts";
import type { RunMode } from "@kernel/run-mode.ts";
import type { RunPhase } from "@kernel/run-step.ts";
import type { Allotment, PhaseRecord } from "../../domain/run-deadline.ts";

/**
 * Starts the run-level wall-clock deadline that holds every agent turn of the run. Armed once, after
 * classification, so that a classify-skip spends no agent time. Until it is armed nothing
 * bounds the run; once it is, a turn the deadline refuses or stops ends the run as a persisted
 * infra-error (E-TIME-BUDGET).
 */
export interface RunDeadlinePort {
  arm(scope: { mode: RunMode }): void;
  /** What was armed (the named budget and its length), for the run's trace. Absent or undefined: nothing to say. */
  describe?(): { label: string; budgetMs: number } | undefined;
  /** Milliseconds left; undefined while no deadline is armed. Zero or less: spent. A deterministic phase that may still start is checked against it before it does. */
  remainingMs?(): number | undefined;
  /** Milliseconds a purpose (omitted: the run's current one) may still spend: the time left less what the purposes after it are owed; null while no deadline is armed. The one reading the run's time decisions share. */
  allowance?(purpose?: DeadlinePurpose): number | null;
  /** What `purpose` may still spend, as `allowance` reads it, without allotting it: the purpose's allotment is told when a turn or a phase is allotted its time, never when a re-run checks what is left. */
  peekAllowance?(purpose: DeadlinePurpose): number | null;
  /** Fires at the instant the run's time is spent; undefined while no deadline is armed. Every child process the launcher starts is killed by it. */
  signal?(): AbortSignal | undefined;
  /** Whether that instant has been reached. */
  fired?(): boolean;
  /** The purpose of the phase the run is in. */
  currentPurpose?(): DeadlinePurpose;
  /** Hands in the app's recent finished runs, from which the reserve of every allotment is read. */
  measure?(records: readonly PhaseRecord[]): void;
  /** The purposes this run will not enter, as its own state stands: they are owed no time, so none is held back for them. */
  willNotEnter?(purposes: readonly DeadlinePurpose[]): void;
  /** The run entered a phase: an allowance asked for without a purpose is that phase's. */
  enter?(phase: RunPhase): void;
  /** Told once per purpose, the first time it is allotted time. */
  observe?(listener: (allotment: Allotment) => void): void;
}
