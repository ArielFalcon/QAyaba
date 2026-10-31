import type { RunMode } from "@kernel/run-mode.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import { ERROR_CLASS } from "../../../shared-kernel/error-class.ts";
import { shouldDistillLearning } from "./should-distill-learning.ts";

/** Classes that teach the engine nothing: an outage, a flaky test, a generation that decided nothing, a login the run could not complete, or a generation stopped by the clock, which DEV latency confounds, or a run whose reviewer was unavailable, so its tests were never judged, or a run that could not run agent code safely (no sandbox uid, egress filter down under enforce). */
/* `internal-error` and `security-refusal` are the shell's own classes: the run never got to test the app, so neither teaches. */
export const NON_LEARNING: ReadonlySet<string> = new Set([ERROR_CLASS.INFRA, ERROR_CLASS.FLAKY, ERROR_CLASS.NO_DECISION, ERROR_CLASS.NO_AUTHOR, ERROR_CLASS.PRECONDITION, ERROR_CLASS.TIME_BUDGET, ERROR_CLASS.REVIEWER_UNAVAILABLE, ERROR_CLASS.REVIEW_DISPUTED, ERROR_CLASS.SANDBOX, "internal-error", "security-refusal"]);

/** Classes that teach nothing but whose recurrence an operator must be able to see: the run ended on a limit of the engine's own (its time) or on a collaborator it could not reach (its reviewer), and a streak of them is an operating condition to watch, never an engine defect or a rule to learn. They reach the process audit's observe-only signal and nothing else. */
export const OBSERVED_OPERATING: ReadonlySet<string> = new Set([ERROR_CLASS.TIME_BUDGET, ERROR_CLASS.REVIEWER_UNAVAILABLE]);

export interface LearningGateInput {
  verdict: RunVerdict;
  /** A context run builds an architecture map, not tests, so nothing it ends with teaches the engine. */
  mode: RunMode;
  errorClass: string | null | undefined;
  adjudicationClass?: string | undefined;
}

export interface LearningGates {
  /** Whether the outcome feeds the process audit. */
  audit: boolean;
}

/**
 * The one place that decides whether a run's outcome reaches the process audit. A context run never does; every
 * other run starts from `shouldDistillLearning` (an app defect never does). The audit is stricter still: never for a
 * flaky run, and only for a real class that teaches.
 */
export function learningGates(input: LearningGateInput): LearningGates {
  const distill = input.mode !== "context" && shouldDistillLearning(input.adjudicationClass);
  const teaches = !!input.errorClass && !NON_LEARNING.has(input.errorClass);
  return { audit: distill && input.verdict !== "flaky" && teaches };
}

/**
 * Whether an outcome reaches the process audit for its operating signal alone: its class teaches nothing (so
 * `learningGates` keeps it out of the audit) but its recurrence is visible. A context
 * run is never audited, as it never teaches.
 */
export function observesOperatingSignal(input: { mode: RunMode; errorClass: string | null | undefined }): boolean {
  return input.mode !== "context" && !!input.errorClass && OBSERVED_OPERATING.has(input.errorClass);
}
