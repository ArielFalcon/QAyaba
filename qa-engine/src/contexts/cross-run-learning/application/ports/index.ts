/* Off-path flywheel ports (stubbed in v1; never gates publish). ErrorClass stays in THIS context (no kernel leak) — modeled as a local string-literal union. */

import type { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { RelevanceBias } from "@contexts/cross-run-learning/domain/rule-governance.service.ts";
export type { RelevanceBias };

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
export interface LearningRepositoryPort {
  save(rule: LearningRule): Promise<void>;
  topRules(app: string, sha: Sha, limit: number, relevance?: RelevanceBias): Promise<LearningRule[]>;
  applyOutcome(outcome: RunOutcome): Promise<void>;
  incrementUsage?(ids: readonly string[]): Promise<void>;
  /* Optional (same optionality convention as incrementUsage above) so a caller/fake/store that never distills need not implement it. A store/fake that still omits selectAllRules remains a fail-open no-op (empty existing set), never a stricter gate than before this method existed — that fallback is preserved for tests only now. */
  listAll?(app: string, limit: number): Promise<LearningRule[]>;
}
/** What the quarantine command needs of the learning store: every rule of the app (retired ones included) and a way to set some aside. */
export interface LearningQuarantinePort {
  listAll(app: string, limit: number): Promise<LearningRule[]>;
  /** Marks the app's rules by id as quarantined at `at`; those already quarantined are left as they are. Returns how many it newly marked. */
  quarantine(app: string, ids: readonly string[], at: string): Promise<number>;
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


export interface ReflectorPort {
  reflect(input: ReflectionInput): Promise<void>;
}

/** Off-path, fault-isolated. Absent means the audit never runs. This context never imports src/. */
export interface ProcessAuditPort {
  audit(outcome: RunOutcome): Promise<void>;
}
