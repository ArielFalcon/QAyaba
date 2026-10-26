import type { QaCase } from "@kernel/qa-case.ts";
import type { RetrievedRule } from "@contexts/cross-run-learning/application/index.ts";

/**
 * `priorCorrections` lets the next review judge convergence on previously
 * raised blocking issues instead of inventing new nits.
 */
export interface ReviewEnrichment {
  priorCorrections?: readonly string[];
  /* The spec lines that changed since the prior rejection, already bounded and rendered. */
  specChanges?: string;
  /* Paths of the suite's existing specs: context only, never a target and never a reason to reject. */
  existingSpecFiles?: readonly string[];
  /**
   * Same retrieved rules the generator saw. The adapter renders only active
   * rules; candidates are for the generator to explore, never for the judge to
   * gate on.
   */
  learnedRules?: readonly RetrievedRule[];
  /**
   * Live DEV a11y snapshot of routes under review. Absent: the reviewer defers
   * on unverifiable UI facts.
   */
  domSnapshot?: string;
  /**
   * The run's own execution of the specs under review (verdict and cases). The adapter renders it as
   * the reviewer's execution evidence, so an app defect (a 5xx, a redirect, a runtime error) is
   * distinguishable from a test defect without asking the generator. Absent: the prompt carries none.
   */
  executionEvidence?: { verdict: string; cases: readonly QaCase[] };
  /** Per-run id for the reviewer SSE session (separate from the generator's). */
  runId?: string;
}

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

export interface ReviewPort {
  /**
   * `diff` is the real per-run commit diff; absent falls back to the adapter's
   * static ctx.diff. `enrichment` is independently absent-safe.
   */
  review(specDir: string, cases: readonly QaCase[], diff?: string, enrichment?: ReviewEnrichment): Promise<{
    approved: boolean;
    corrections: string[];
    rationale?: string;
    blockingCount?: number;
    parsed?: boolean;
    /* The reviewer's own severity per correction, and the evidence it cites, in the same order. */
    severities?: ("blocking" | "advisory")[];
    citations?: ({ kind: "contract" | "execution" | "dom"; ref: string } | undefined)[];
    /**
     * True when no judgment was possible because the reviewer's runtime failed or returned nothing: an
     * integration fault, which is neither an approval nor a rejection. Absent on every review that
     * reached a reviewer's answer, including an unreadable one (a parse miss).
     */
    unavailable?: boolean;
    /** What the turn cost. Absent when the port never opened a reviewer session. */
    stats?: ReviewStats;
  }>;
}
