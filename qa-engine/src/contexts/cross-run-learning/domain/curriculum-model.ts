import type { RunVerdict } from "@kernel/run-verdict.ts";

/**
 * Count cap (not byte cap), enforced by the caller so a prompt-section drop
 * cannot silently make `evaluated` counters lie. If the exhaustive subset
 * proof breaks, lower this constant; do not raise the prompt maxBytes.
 */
export const MAX_SELECTED_EXEMPLARS = 3;

export interface SelectedExemplar {
  id: string;
  name: string;
  template: string;
  /** Wide string, not ScenarioArchetype: the narrow union adds nothing a caller can act on here. */
  archetype: string;
  /** Caught a real bug for this app — drives the prompt's PROVEN marker. */
  proven: boolean;
  promotionCount: number;
}

export interface CurriculumFoldInput {
  /** Archetypes actually rendered into this run's generation prompt — never the wider matched set. */
  offered: readonly string[];
  verdict: RunVerdict;
  /** RunOutcome.adjudication?.class (wide string, kernel convention). */
  adjudicationClass?: string;
  /** Absent is unmeasured, which classifyEvidence reads as inconclusive. */
  coverageStatus?: "pass" | "fail" | "unknown";
}
