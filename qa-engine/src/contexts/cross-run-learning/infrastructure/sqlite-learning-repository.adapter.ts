/* The store is injected (no SQLite binary in tests); ranking is delegated to RuleGovernanceService (the SELECT is UNORDERED — the duplicate SQL ORDER BY is gone). The read path coerces 'pending' → 'candidate' BEFORE typing so no row violates the port type and no rule is silently dropped. */
import type { LearningRepositoryPort, LearningRule, RuleStatus, ErrorClass, RelevanceBias } from "../application/ports/index.ts";
import type { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import { RuleGovernanceService } from "../domain/rule-governance.service.ts";

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
}
export interface LearningStore {
  selectRules(app: string): LearningRow[];
  upsert(rule: LearningRule): void;
  recordOutcome(outcome: RunOutcome): void;
  incrementUsage?(ids: readonly string[]): void;
  selectAllRules?(app: string, limit: number): LearningRow[];
}

function coerceStatus(raw: string): RuleStatus {
  if (raw === "active" || raw === "deprecated" || raw === "superseded") return raw;
  return "candidate";
}

function rowToRule(row: LearningRow): LearningRule {
  return {
    id: row.id,
    trigger: row.trigger_text,
    action: row.action_text,
    errorClass: row.error_class as ErrorClass,
    archetype: row.archetype ?? null,
    status: coerceStatus(row.status),
    confidence: row.confidence === "low" ? "low" : row.confidence === "high" ? "high" : "medium",
    usageCount: row.usage_count,
    outcomeCount: row.outcome_count ?? 0,
    oracleOutcomeCount: row.oracle_outcome_count ?? 0,
    successRate: row.success_rate,
    lastVerified: row.last_verified,
    source: row.source,
    at: row.at,
  };
}

export class SqliteLearningRepository implements LearningRepositoryPort {
  private readonly governance = new RuleGovernanceService();
  constructor(private readonly store: LearningStore) {}

  async save(rule: LearningRule): Promise<void> {
    this.store.upsert(rule);
  }

  async topRules(app: string, _sha: Sha, limit: number, relevance?: RelevanceBias): Promise<LearningRule[]> {
    const rules = this.store.selectRules(app).map(rowToRule);
    return this.governance.topRules(rules, limit, relevance);
  }

  async applyOutcome(outcome: RunOutcome): Promise<void> {
    this.store.recordOutcome(outcome);
  }

  /* Off-path telemetry: increment usage on retrieved rules. A store fake that omits incrementUsage is unaffected. Never gates publish. */
  async incrementUsage(ids: readonly string[]): Promise<void> {
    this.store.incrementUsage?.(ids);
  }

  /* Delegates to the injected store's selectAllRules when present; omitted collaborator is a fail-open no-op ([]). Never gates publish. */
  async listAll(app: string, limit: number): Promise<LearningRule[]> {
    const rows = this.store.selectAllRules?.(app, limit) ?? [];
    return rows.map(rowToRule);
  }
}
