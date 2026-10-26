/**
 * Adapter catch produces `${REVIEWER_UNAVAILABLE_MARKER}: <reason>`; the
 * use-case matches on it. One constant so producer and matcher cannot drift.
 */
export const REVIEWER_UNAVAILABLE_MARKER = "reviewer unavailable";

/**
 * Authoritative publish-gate seam. `blockingCount` distinguishes blocking
 * corrections from advisory ones. `parsed` is false only on a parse miss — not
 * a real rejection — so FixLoop re-prompts once instead of burning a fix round.
 * Fail-closed: a missing parse is never treated as approval.
 */
/**
 * What one reviewer turn cost, as its own runtime reported it. Every figure is optional and absent
 * when the runtime did not report it: never a fabricated zero. `durationMs` is always measured by the
 * adapter. Persisted on the run's reviewer signal, never read back into the verdict.
 */
export interface ReviewStats {
  durationMs: number;
  promptBytes: number;
  outputChars: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  steps?: number;
}
