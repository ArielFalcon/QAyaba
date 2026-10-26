/* The ledger the learning fold and the rule repository read and write: rules by app, their outcomes, and the per-run oracle scorecard. The shell implements it over its history store. */
import type { LearningRow, ScorecardEntryInput } from "../../domain/learning-store-model.ts";
import type { LearningRule } from "../../domain/learning-repository.ts";

export interface LearningStorePort {
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
