/* What a run's trace says about how it ended, beyond the verdict: the publication decision, how generation ended and the limit that stopped the run. It rides on the outcome object the engine returns without being a field of it: the outcome's shape is the persisted one (pinned by the seam-parity contract), and these facts are for the shell that opens the run's root span, never stored. */

export interface RunTraceFacts {
  /* "pr" | "issue" | "shadow-log" | "quarantine" | "none"; absent when the run ended before it had a decision (an unhandled error). */
  decision?: string;
  generationEnd?: string;
  /* A value of the limit vocabulary: "tier-budget" | "run-deadline" | "step-cap". */
  limitFired?: string;
  limitRole?: string;
  /* Whether the engine ran a reviewer for this run (the same rule the generation applies), decided at run time. */
  reviewRequired?: boolean;
  /* The engine's change-coverage decision, absent when the run never measured, and the policy in force. Grading reads these and never the app's current configuration. */
  coverage?: { status?: "pass" | "fail" | "unknown"; mode: string; minRatio?: number };
}

const factsOfOutcome = new WeakMap<object, RunTraceFacts>();

/* Remembers the facts for `outcome` and returns it. */
export function attachTraceFacts<T extends object>(outcome: T, facts: RunTraceFacts): T {
  factsOfOutcome.set(outcome, facts);
  return outcome;
}

export function traceFactsOf(outcome: object): RunTraceFacts | undefined {
  return factsOfOutcome.get(outcome);
}
