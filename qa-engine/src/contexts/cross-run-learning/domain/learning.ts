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

/**
 * Port-local RelevanceBias — mirrors cross-run-learning's RuleGovernanceService.RelevanceBias
 * structurally (no cross-context import). Deterministic retrieval-time bias toward rules whose errorClass/archetype matches THIS
 * run's own signals (never an LLM signal) — see learning-port.adapter.ts for what RunQaUseCase
 * actually has available to populate it with at retrieval time.
 */
export interface RelevanceBias {
  errorClass?: string | null;
  archetypes?: readonly string[];
}
