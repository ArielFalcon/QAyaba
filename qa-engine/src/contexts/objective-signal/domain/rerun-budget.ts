/* Whether a re-run of the mutation pass fits the time the run's coverage purpose has left, estimated from the run's own final execution. Pure; no I/O. */
import type { QaCase } from "@kernel/qa-case.ts";
import { testOfCase } from "./dump-names.ts";

/** Why the mutation pass left a re-run out: the coverage purpose's time could not hold it. */
export const RERUN_LEFT_OUT_FOR_TIME = "time";

/** The re-runs of a mutation pass that were not started, and why: the mutants left out unjudged, and the unmutated observations (the one before and the one after the mutants) whose absence leaves the survivors unobserved. */
export interface RerunsLeftOut {
  mutants: number;
  observations: number;
  reason: typeof RERUN_LEFT_OUT_FOR_TIME;
}

/** What the re-runs of a mutation pass are held to: the time the coverage purpose may still spend (null while nothing bounds the run), and the cases of the run's final execution, whose measured durations estimate each re-run. */
export interface RerunBudget {
  allowance: () => number | null;
  cases: readonly QaCase[];
}

/** The measured time of the cases a re-run of `specFiles` executes, only those `tests` names when it names them; undefined when no case is known for it or one of them has no measured duration. */
export function rerunEstimateMs(cases: readonly QaCase[], specFiles: readonly string[], tests?: readonly string[]): number | undefined {
  const named = tests === undefined ? undefined : new Set(tests);
  const executed = cases.filter((c) => c.file !== undefined && specFiles.includes(c.file) && (named === undefined || named.has(testOfCase(c.name))));
  if (executed.length === 0 || executed.some((c) => c.durationMs === undefined)) return undefined;
  return executed.reduce((sum, c) => sum + c.durationMs!, 0);
}

/** What a re-run of this pass took against the time its cases took in the final execution. */
export interface MeasuredRerun {
  wallMs: number;
  estimateMs: number;
}

/**
 * A re-run's estimate once a re-run of the same pass has been measured: its cases' time scaled by that re-run's wall time over its own
 * cases' time, so what a re-run costs beyond its tests (the process start, the instrumentation, the observation) is a fact of this run;
 * the cases' time alone before any re-run was measured, and undefined with no estimate.
 */
export function scaledEstimateMs(estimateMs: number | undefined, measured: MeasuredRerun | undefined): number | undefined {
  if (estimateMs === undefined || measured === undefined || measured.estimateMs <= 0) return estimateMs;
  return Math.round(estimateMs * (measured.wallMs / measured.estimateMs));
}

/** Whether a re-run may start: nothing bounds the run, or the allowance is not spent and holds the estimate (a re-run with no estimate is held only to an allowance that is not spent). */
export function rerunFits(allowanceMs: number | null, estimateMs: number | undefined): boolean {
  if (allowanceMs === null) return true;
  if (allowanceMs <= 0) return false;
  return estimateMs === undefined || estimateMs <= allowanceMs;
}
