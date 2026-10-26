import type { ErrorClass } from "@kernel/error-class";

export type RuleStatus = "candidate" | "active" | "deprecated" | "superseded";
export type Confidence = "low" | "medium" | "high";

export interface LearningRule {
  id: string;
  trigger: string;
  action: string;
  errorClass: ErrorClass;
  /*
   * The diff's structural shape this rule applies to (form, api-call, data-list, …), captured at
   * distill time from detectStructuralPatterns. Lets retrieval bias toward rules matching the
   * CURRENT change's shape, not just its error class. null/undefined when the rule is untagged.
   */
  archetype?: string | null;
  confidence: Confidence;
  usageCount: number;  /* times this rule was retrieved into a prompt */
  outcomeCount: number;  /* times an objective outcome (valueScore) was folded in */
  /*
   * Outcomes folded via an oracle-scored path (valueScore !== null). Defaults to 0 for rows
   * that predate this column. Prevention credit cannot by itself promote candidate → active.
   */
  oracleOutcomeCount: number;
  successRate: number | null;  /* running mean of outcomes in [0,1] (null until first outcome) */
  lastVerified: string | null;
  source: string;
  status: RuleStatus;
  at: string;
  /** When an operator quarantined the rule (set it aside without deleting it); null while it is in force. A quarantined rule is never retrieved and never credited an outcome. */
  quarantinedAt?: string | null;
}

export interface RuleUpsert {
  trigger: string;
  action: string;
  errorClass: ErrorClass;
  archetype?: string | null;
  source: string;
}
