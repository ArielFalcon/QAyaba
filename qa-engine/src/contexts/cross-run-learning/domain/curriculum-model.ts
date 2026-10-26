import type { RunVerdict } from "@kernel/run-verdict.ts";

/**
 * Count cap (not byte cap), enforced by the caller so a prompt-section drop
 * cannot silently make `evaluated` counters lie. If the exhaustive subset
 * proof breaks, lower this constant; do not raise the prompt maxBytes.
 */
export const MAX_SELECTED_EXEMPLARS = 3;

export interface CurriculumFoldInput {
  /** Archetypes actually rendered into this run's generation prompt — never the wider matched set. */
  offered: readonly string[];
  verdict: RunVerdict;
  /** RunOutcome.adjudication?.class (wide string, kernel convention). */
  adjudicationClass?: string;
  /** Absent is unmeasured, which classifyEvidence reads as inconclusive. */
  coverageStatus?: "pass" | "fail" | "unknown";
}

/*
 * Distinct from `null` ("no curriculum yet — start fresh"): a load result of CURRICULUM_CORRUPT
 * means a row EXISTS but could not be parsed. Only fold() writes, and it refuses a corrupt row
 * (reported through onError, never saved over), so the corrupt row survives for an operator to
 * inspect instead of being silently replaced by a fresh curriculum. select() only reads: it
 * reports the corrupt row the same way but still ranks against a fresh curriculum, so exemplar
 * selection keeps working while the row awaits repair.
 */
export const CURRICULUM_CORRUPT = Symbol("curriculum-corrupt");
