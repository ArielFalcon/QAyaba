/* Whether a generation runs the reviewer's session of its own. Pure: the run's review setting and mode in, the answer out. */
import type { RunMode } from "@kernel/run-mode.ts";

/**
 * A context run's product is the architecture map, not tests: there is nothing for a test reviewer
 * to judge, and a verdict it cannot give would read as a rejection. Every other mode follows the
 * run's review setting.
 */
export function generationRunsReviewer(input: { needsReview: boolean; mode: RunMode }): boolean {
  return input.needsReview && input.mode !== "context";
}
