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

export interface StructuredReflection {
  goal: string;
  decision: string;
  assumption: string;
  errorClass: ErrorClass;
  gateSignal: string;
  evidence: string;
  rootCause: string;
  preventiveRule: { trigger: string; action: string };
}

export interface ReflectionInput {
  runId: string;
  app: string;
  sha: string;
  mode: string;
  verdict: string;
  errorClass: ErrorClass;
  gateSignals: {
    static: boolean;
    coverageRatio: number | null;
    valueScore: number | null;
    reviewerCorrections: string[];
    flaky: boolean;
    retries: number;
  };
  archetype?: string | null;
}
