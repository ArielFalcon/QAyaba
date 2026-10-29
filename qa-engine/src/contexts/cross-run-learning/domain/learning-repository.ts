export type ErrorClass = string;

export type RuleStatus = "candidate" | "active" | "deprecated" | "superseded";

export interface LearningRule {
  id: string;
  trigger: string;
  action: string;
  errorClass: ErrorClass;
  archetype?: string | null;
  status: RuleStatus;
  confidence: "low" | "medium" | "high";
  usageCount: number;
  outcomeCount: number;
  oracleOutcomeCount: number;
  successRate: number | null;
  lastVerified: string | null;
  source: string;
  at: string;
  /** When an operator quarantined the rule (set aside without deleting it): a quarantined rule is never retrieved and never folded onto. Absent or null: in force. */
  quarantinedAt?: string | null;
}
