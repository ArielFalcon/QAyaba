/* The ledger the learning fold and the rule repository read and write: rules by app, their outcomes, and the per-run oracle scorecard. The shell implements it over its history store. */
import type { TestTarget } from "@kernel/run-mode.ts";
import type { LearningRule } from "../../domain/learning-repository.ts";

export interface LearningRow {
  id: string;
  trigger_text: string;
  action_text: string;
  error_class: string;
  archetype: string | null;
  status: string;
  confidence: string;
  usage_count: number;
  outcome_count: number;
  oracle_outcome_count?: number;
  success_rate: number | null;
  last_verified: string | null;
  source: string;
  at: string;
  /** Set when an operator quarantined the rule; null or absent: in force. */
  quarantined_at?: string | null;
}

/* One run's oracle result; a count that is null was not measured, which is distinct from a measured zero. */
export interface ScorecardEntryInput {
  runId: string;
  app: string;
  sha: string;
  target: TestTarget;
  valueScore: number | null;
  mutantCount: number | null;
  killedCount: number | null;
  at: string;
}

export interface LearningStore {
  selectRules(app: string): LearningRow[];
  upsert(rule: LearningRule): void;
  incrementUsage?(ids: readonly string[]): void;
  selectAllRules?(app: string, limit: number): LearningRow[];
  /** Marks the app's rules by id as quarantined at `at` (those not already) and returns how many it marked. */
  quarantine?(app: string, ids: readonly string[], at: string): number;
  /** Appends one run's oracle result to the app's scorecard. */
  saveScorecardEntry(entry: ScorecardEntryInput): void;
  /** One rule of the store's own app by id, uncapped: undefined when it was deleted or belongs to another app. */
  findRule(id: string): LearningRule | undefined;
  /** Folds one score onto a rule; a rule retired since it was retrieved is skipped by the store. */
  recordRuleOutcome(ruleId: string, score: number, coverageCreditConfirmed: boolean | null, isOracleScore?: boolean): void;
}
