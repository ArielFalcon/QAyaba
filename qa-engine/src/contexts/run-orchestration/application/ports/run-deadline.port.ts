import type { RunMode } from "@kernel/run-mode.ts";

/**
 * Starts the run-level wall-clock deadline that holds every agent turn of the run. Armed once, after
 * classification, because a diff run's budget follows the size of its change. Until it is armed nothing
 * bounds the run; once it is, a turn the deadline refuses or stops ends the run as a persisted
 * infra-error (E-TIME-BUDGET).
 */
export interface RunDeadlinePort {
  arm(scope: { mode: RunMode; diff?: string; changedFiles?: readonly string[] }): void;
  /** What was armed (the named budget and its length), for the run's trace. Absent or undefined: nothing to say. */
  describe?(): { label: string; budgetMs: number } | undefined;
  /** Milliseconds left; undefined while no deadline is armed. Zero or less: spent. A deterministic phase that may still start is checked against it before it does. */
  remainingMs?(): number | undefined;
  /** Milliseconds a purpose may still spend (never more than `remainingMs()`); null while no deadline is armed. The one reading the run's time decisions share. */
  allowance?(purpose: "first-pass" | "regeneration"): number | null;
}
