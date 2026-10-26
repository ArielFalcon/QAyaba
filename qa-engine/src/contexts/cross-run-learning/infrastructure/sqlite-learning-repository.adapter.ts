/* The store is injected (no SQLite binary in tests); ranking is delegated to RuleGovernanceService (the SELECT is UNORDERED — the duplicate SQL ORDER BY is gone). */
import type { LearningRepositoryPort } from "../application/ports/learning-repository.port.ts";
import type { LearningStorePort } from "../application/ports/learning-store.port.ts";
import type { LearningRow } from "../domain/learning-store-model.ts";
import { FoldRunOutcome } from "../application/fold-run-outcome.use-case.ts";
import type { LearningRule, RuleStatus, ErrorClass } from "../domain/learning-repository.ts";
import type { RelevanceBias } from "../domain/rule-governance.service.ts";
import type { Sha } from "@kernel/sha.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { RuleGovernanceService, type InjectionPolicy } from "../domain/rule-governance.service.ts";

function rowToRule(row: LearningRow): LearningRule {
  return {
    id: row.id,
    trigger: row.trigger_text,
    action: row.action_text,
    errorClass: row.error_class as ErrorClass,
    archetype: row.archetype ?? null,
    status: row.status as RuleStatus,
    confidence: row.confidence === "low" ? "low" : row.confidence === "high" ? "high" : "medium",
    usageCount: row.usage_count,
    outcomeCount: row.outcome_count ?? 0,
    oracleOutcomeCount: row.oracle_outcome_count ?? 0,
    successRate: row.success_rate,
    lastVerified: row.last_verified,
    source: row.source,
    at: row.at,
    quarantinedAt: row.quarantined_at ?? null,
  };
}

export class SqliteLearningRepository implements LearningRepositoryPort {
  private readonly governance = new RuleGovernanceService();
  /**
   * `reflectorUnproven: false` retrieves only rules that earned their place (active, above low confidence) from the reflector,
   * so none of its output reaches a prompt before it has proven itself; a deterministic distiller's rules keep their normal governance. Absent: every retrievable rule, as before; the composition root decides.
   */
  constructor(
    private readonly store: LearningStorePort,
    private readonly policy: InjectionPolicy = { reflectorUnproven: true },
    private readonly redaction?: RedactionPort,
  ) {}

  async save(rule: LearningRule): Promise<void> {
    this.store.upsert(rule);
  }

  async topRules(app: string, _sha: Sha, limit: number, relevance?: RelevanceBias): Promise<LearningRule[]> {
    const rules = this.store.selectRules(app).map(rowToRule);
    return this.governance.topRules(rules, limit, relevance, this.policy);
  }

  async applyOutcome(outcome: RunOutcome): Promise<void> {
    new FoldRunOutcome(this.store, this.redaction).execute(outcome);
  }

  /* Off-path telemetry: increment usage on retrieved rules. A store fake that omits incrementUsage is unaffected. Never gates publish. */
  async incrementUsage(ids: readonly string[]): Promise<void> {
    this.store.incrementUsage?.(ids);
  }

  /** Sets the rules aside without deleting them: they are never retrieved or folded onto again. Returns how many were newly marked. A store that cannot do it throws, since a quarantine that silently did nothing is worse than none. */
  async quarantine(app: string, ids: readonly string[], at: string): Promise<number> {
    if (ids.length === 0) return 0;
    if (!this.store.quarantine) throw new Error("this learning store cannot quarantine rules");
    return this.store.quarantine(app, ids, at);
  }

  /* Delegates to the injected store's selectAllRules when present; omitted collaborator is a fail-open no-op ([]). Never gates publish. */
  async listAll(app: string, limit: number): Promise<LearningRule[]> {
    const rows = this.store.selectAllRules?.(app, limit) ?? [];
    return rows.map(rowToRule);
  }
}
