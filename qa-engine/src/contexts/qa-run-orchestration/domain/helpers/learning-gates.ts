import type { RunVerdict } from "@kernel/run-verdict.ts";
import { ERROR_CLASS } from "./error-class.ts";
import { shouldDistillLearning } from "./should-distill-learning.ts";

/** Classes that teach the engine nothing: an outage, a flaky test, or a generation that decided nothing. */
export const NON_LEARNING: ReadonlySet<string> = new Set([ERROR_CLASS.INFRA, ERROR_CLASS.FLAKY, ERROR_CLASS.NO_DECISION]);

export interface LearningGateInput {
  /** `mainline` is a run that executed its suite; `terminal` ended earlier (before or without execution). */
  stage: "mainline" | "terminal";
  verdict: RunVerdict;
  errorClass: string | null | undefined;
  isCode: boolean;
  adjudicationClass?: string | undefined;
}

export interface LearningGates {
  /** Whether the outcome feeds the deterministic learning fold. */
  fold: boolean;
  /** Whether the outcome feeds the reflector and the process audit. */
  reflect: boolean;
}

/**
 * The one place that decides what a run's outcome may teach. Everything starts from
 * `shouldDistillLearning` (a code-mode failure or an app defect never teaches). A mainline run
 * folds whatever its class, so a green pass still counts; a terminal outcome folds only when its
 * class teaches. The reflector is stricter: never for a flaky run, and only for a real class that
 * teaches, so a green pass cannot mint a reflection rule.
 */
export function learningGates(input: LearningGateInput): LearningGates {
  const distill = shouldDistillLearning(input.isCode, input.verdict, input.adjudicationClass);
  const teaches = !!input.errorClass && !NON_LEARNING.has(input.errorClass);
  return {
    fold: distill && (input.stage === "mainline" || teaches),
    reflect: distill && input.verdict !== "flaky" && teaches,
  };
}
