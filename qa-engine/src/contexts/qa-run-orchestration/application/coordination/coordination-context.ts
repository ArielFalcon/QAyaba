// Minimal projection for the coordinator. Must never contain OpencodeRunInput (diff, specs,
// learned rules, DOM, provider, …). AcceptanceCriterion has no schema in the architecture
// document; a criterion is its statement until DelegationBrief (Fase 3) needs more structure.
import type { CoordinationBudget } from "./coordination-budget.ts";
import type { EvidenceRef } from "./evidence-ref.ts";

export type AcceptanceCriterion = string;

export interface CoordinationContext {
  readonly runId: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly evidence: readonly EvidenceRef[];
  readonly budgets: CoordinationBudget;
}
