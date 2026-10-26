/* What a retrieved learning rule and a selected exemplar look like where the ledger, the run flow and the generation prompt meet. */

/**
 * Port-boundary projection of a retrieved learning rule. `status` is only
 * "active" | "candidate" because deprecated/superseded rules are never retrieved.
 */
export interface RetrievedRule {
  /**
   * Ledger primary key for outcome-fold attribution. Never rendered into a
   * prompt. `trigger` is the prompt-facing text and must never be used for fold
   * attribution.
   */
  id: string;
  trigger: string;
  action: string;
  errorClass: string;
  status: "active" | "candidate";
  confidence: "low" | "medium" | "high";
}

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
