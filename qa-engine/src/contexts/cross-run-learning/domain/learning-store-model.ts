/* What the learning ledger stores for a rule, and what it keeps of a run's oracle result. */
import type { TestTarget } from "@kernel/run-mode.ts";

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
