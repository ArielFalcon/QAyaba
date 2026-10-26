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
