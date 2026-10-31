import type { RunMode } from "@kernel/run-mode.ts";

/* Whether a run has an independent review: its app asks for one and the run's product is tests. A context run's product is the architecture map, so there is nothing for a test reviewer to judge. */
export function reviewRequired(input: { needsReview: boolean; mode: RunMode }): boolean {
  return input.needsReview && input.mode !== "context";
}
