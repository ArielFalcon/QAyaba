/* Minimal coordinator projection. Must never contain OpencodeRunInput (diff, specs, learned rules, DOM, provider). An AcceptanceCriterion is its statement string. */
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
