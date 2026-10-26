import { applyOutcome as foldApplyOutcome, CURRICULUM_CORRUPT } from "@contexts/cross-run-learning/application/index";
import type { ErrorClass } from "@kernel/error-class";
import { logJson } from "../../../integrations/logger";
import { RedactionPortAdapter } from "../../../orchestrator/sanitizer";
import type { Curriculum } from "../../../qa/learning/curriculum";
import { type Confidence, type LearningRule, type RuleStatus, type RuleUpsert } from "../../../qa/learning/learning-rule";
import { updateScorecard, type Scorecard, type ScorecardEntry } from "../../../qa/learning/oracle-types";
import type { RunMode, RunOutcome, RunRecord, RunVerdict, StructuredReflection, TestTarget } from "../../../types";
import type { HistoryDatabase } from "../database";
import { parseJsonColumn } from "../json-column";

const redactionPort = new RedactionPortAdapter();

/*
 * The shared "give me the live ledger, not a truncated preview" cap for operator-facing ledger views (TUI/API intelligence view, CLI
 * `qayaba intel`). Neither generation's retrieve path (listLearningRulesForGovernance) nor the fold (getLearningRule, a direct by-id
 * lookup) reads through this cap, so ledger size can never hide a rule from ranking or drop a fold. Not used by chat.ts's learning
 * context, which is a deliberately small bounded prompt preview, not a ledger view.
 */
export const LEARNING_RULE_LEDGER_LIMIT = 200;

const EMPTY_GATE_SIGNALS: RunOutcome["gateSignals"] = { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 };

/* What a run taught: run_outcomes (append-only), learning_rules, the curriculum and the scorecard. */
export class LearningRepository {
  private readonly insertOutcome;
  private readonly reclassifyOutcome;
  private readonly listOutcomes;
  private readonly getOutcome;
  private readonly setReflection;
  private readonly upsertRule;
  private readonly listRules;
  private readonly listRetrievableRules;
  private readonly getRule;
  private readonly getAppRule;
  private readonly listAllRules;
  private readonly incrementUsage;
  private readonly foldRule;
  private readonly setStatus;
  private readonly quarantine;
  private readonly releaseQuarantine;
  private readonly loadCurriculumRow;
  private readonly saveCurriculumRow;
  private readonly loadScorecardRow;
  private readonly saveScorecardRow;

  constructor(private readonly db: HistoryDatabase) {
    const raw = db.raw;
    this.insertOutcome = raw.prepare(`
      INSERT INTO run_outcomes (id, app, sha, mode, target, verdict, error_class, gate_signals, rules_retrieved, reflection, at)
      VALUES (@id, @app, @sha, @mode, @target, @verdict, @errorClass, @gateSignals, @rulesRetrieved, @reflection, @at)
    `);
    this.reclassifyOutcome = raw.prepare("UPDATE run_outcomes SET verdict = 'infra-error', error_class = ? WHERE id = ?");
    this.listOutcomes = raw.prepare("SELECT * FROM run_outcomes WHERE app = ? ORDER BY at DESC, rowid DESC LIMIT ?");
    this.getOutcome = raw.prepare("SELECT * FROM run_outcomes WHERE id = ?");
    this.setReflection = raw.prepare("UPDATE run_outcomes SET reflection = ? WHERE id = ?");
    this.upsertRule = raw.prepare(`
      INSERT INTO learning_rules (id, app, trigger_text, action_text, error_class, archetype, confidence, usage_count, outcome_count, oracle_outcome_count, success_rate, last_verified, source, status, at)
      VALUES (@id, @app, @trigger, @action, @errorClass, @archetype, @confidence, @usageCount, @outcomeCount, @oracleOutcomeCount, @successRate, @lastVerified, @source, @status, @at)
      ON CONFLICT(id) DO UPDATE SET
        confidence = excluded.confidence,
        usage_count = excluded.usage_count,
        outcome_count = excluded.outcome_count,
        oracle_outcome_count = excluded.oracle_outcome_count,
        success_rate = excluded.success_rate,
        last_verified = excluded.last_verified,
        status = excluded.status
        -- archetype, trigger, action, error_class are intentionally NOT updated: they are set-once at
        -- insert (a rule's identity/shape never changes). Distilled IDs are random so this branch only
        -- fires on an explicit stable-ID re-upsert (tests), where preserving the original is correct.
    `);
    this.listRules = raw.prepare("SELECT * FROM learning_rules WHERE app = ? AND status IN ('active', 'candidate') AND quarantined_at IS NULL ORDER BY (status = 'active') DESC, COALESCE(success_rate, 0) DESC, at DESC LIMIT ?");
    /*
     * Governance-path fetch: every retrievable row, no ORDER BY and no LIMIT. Ranking is RuleGovernanceService's job alone; any SQL-side
     * cap would have to pre-rank to decide what to keep, and no SQL order can match governance's ranking (success rate plus the per-run
     * relevance bias, plus the newest-candidate exploration slots), so a cap always hides rules governance would pick.
     */
    this.listRetrievableRules = raw.prepare("SELECT * FROM learning_rules WHERE app = ? AND status IN ('active', 'candidate') AND quarantined_at IS NULL");
    this.getRule = raw.prepare("SELECT * FROM learning_rules WHERE id = ?");
    this.getAppRule = raw.prepare("SELECT * FROM learning_rules WHERE app = ? AND id = ?");
    this.listAllRules = raw.prepare("SELECT * FROM learning_rules WHERE app = ? ORDER BY at DESC LIMIT ?");
    this.incrementUsage = raw.prepare("UPDATE learning_rules SET usage_count = usage_count + 1 WHERE id = ?");
    this.foldRule = raw.prepare(
      "UPDATE learning_rules SET success_rate = ?, outcome_count = ?, oracle_outcome_count = ?, confidence = ?, status = ?, last_verified = ? WHERE id = ?",
    );
    this.setStatus = raw.prepare("UPDATE learning_rules SET status = ?, last_verified = ? WHERE id = ?");
    this.quarantine = raw.prepare("UPDATE learning_rules SET quarantined_at = ? WHERE app = ? AND id = ? AND quarantined_at IS NULL");
    this.releaseQuarantine = raw.prepare("UPDATE learning_rules SET quarantined_at = NULL WHERE id = ? AND quarantined_at IS NOT NULL");
    this.loadCurriculumRow = raw.prepare("SELECT data, updated_at FROM curriculum WHERE app = ?");
    this.saveCurriculumRow = raw.prepare("INSERT INTO curriculum (app, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(app) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at");
    this.loadScorecardRow = raw.prepare("SELECT data FROM scorecard WHERE app = ?");
    this.saveScorecardRow = raw.prepare("INSERT INTO scorecard (app, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(app) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at");
  }

  /* Removes what an app's runs taught: outcomes, rules, curriculum and scorecard. Returns nothing; a table that holds no row for the app is left as it is. */
  deleteApp(app: string): void {
    this.db.write(() => {
      for (const table of ["run_outcomes", "learning_rules", "curriculum", "scorecard"]) this.db.statement(`DELETE FROM ${table} WHERE app = ?`).run(app);
    });
  }

  saveRunOutcome(outcome: RunOutcome): void {
    this.db.write(() => this.writeOutcome(outcome));
  }

  private writeOutcome(outcome: RunOutcome): void {
    this.insertOutcome.run({
      id: outcome.runId,
      app: outcome.app,
      sha: outcome.sha,
      mode: outcome.mode,
      target: outcome.target,
      verdict: outcome.verdict,
      errorClass: outcome.errorClass ?? null,
      gateSignals: JSON.stringify(outcome.gateSignals),
      rulesRetrieved: JSON.stringify(outcome.rulesRetrieved),
      reflection: outcome.reflection ? JSON.stringify(outcome.reflection) : null,
      at: outcome.at,
    });
  }

  /*
   * A run that ended on an unhandled error keeps the class the shell reports. The engine may already have persisted an outcome
   * carrying the evidence the sandbox saw, with a placeholder class: that row is reclassified, never replaced, and a run that has
   * no outcome row gets the minimal one. The run's record, its outcome, the trace root, the run metric and the infra_error grader
   * then name one class, and the outcome says the verdict the record does.
   */
  saveCrashedRunOutcome(record: RunRecord, errorClass: ErrorClass): void {
    this.db.write(() => {
      if (this.reclassifyOutcome.run(errorClass, record.id).changes > 0) return;
      this.writeOutcome({
        runId: record.id,
        app: record.app,
        sha: record.sha,
        mode: record.mode,
        target: record.target,
        verdict: "infra-error",
        errorClass,
        gateSignals: EMPTY_GATE_SIGNALS,
        rulesRetrieved: [],
        at: new Date().toISOString(),
      });
    });
  }

  private rowToOutcome(row: Record<string, unknown>): RunOutcome {
    const id = row.id as string;
    const site = (column: string) => ({ table: "run_outcomes", column, id });
    return {
      runId: id,
      app: row.app as string,
      sha: row.sha as string,
      mode: row.mode as RunMode,
      target: row.target as TestTarget,
      verdict: row.verdict as RunVerdict,
      errorClass: (row.error_class as RunOutcome["errorClass"]) ?? null,
      gateSignals: parseJsonColumn(row.gate_signals as string, EMPTY_GATE_SIGNALS, site("gate_signals")),
      rulesRetrieved: parseJsonColumn(row.rules_retrieved as string, [], site("rules_retrieved")),
      reflection: row.reflection ? parseJsonColumn(row.reflection as string, undefined, site("reflection")) : undefined,
      at: row.at as string,
    };
  }

  listRunOutcomes(app: string, limit = 50): RunOutcome[] {
    return (this.listOutcomes.all(app, limit) as Array<Record<string, unknown>>).map((row) => this.rowToOutcome(row));
  }

  /*
   * The persisted RunOutcome for a single run: the structured value signals (change-coverage, oracle score, reviewer rationale,
   * errorClass) the CLI prints in its end-of-run value report. Undefined for a run that produced no outcome row.
   */
  getRunOutcome(runId: string): RunOutcome | undefined {
    const row = this.getOutcome.get(runId) as Record<string, unknown> | undefined;
    return row ? this.rowToOutcome(row) : undefined;
  }

  /*
   * Back-fills the structured reflection onto an already-saved run outcome. The outcome row is written at verdict time, BEFORE the
   * async best-effort reflection exists; without this the `reflection` column stays null and the reflection is computed once to
   * distill a rule and then discarded.
   */
  updateRunOutcomeReflection(runId: string, reflection: StructuredReflection): void {
    this.db.write(() => this.setReflection.run(JSON.stringify(reflection), runId));
  }

  upsertLearningRule(rule: RuleUpsert & { app: string; id: string; initialStatus?: RuleStatus }): void {
    this.db.write(() =>
      this.upsertRule.run({
        id: rule.id,
        app: rule.app,
        trigger: rule.trigger,
        action: rule.action,
        errorClass: rule.errorClass,
        archetype: rule.archetype ?? null,
        confidence: "low" as Confidence,
        usageCount: 0,
        outcomeCount: 0,
        oracleOutcomeCount: 0,
        successRate: null,
        lastVerified: null,
        source: rule.source,
        status: (rule.initialStatus ?? "candidate") as RuleStatus,
        at: new Date().toISOString(),
      }),
    );
  }

  private rowToRule(row: Record<string, unknown>): LearningRule {
    return {
      id: row.id as string,
      trigger: row.trigger_text as string,
      action: row.action_text as string,
      errorClass: row.error_class as ErrorClass,
      archetype: (row.archetype as string | null) ?? null,
      confidence: row.confidence as Confidence,
      usageCount: row.usage_count as number,
      outcomeCount: (row.outcome_count as number) ?? 0,
      oracleOutcomeCount: (row.oracle_outcome_count as number) ?? 0,
      successRate: row.success_rate as number | null,
      lastVerified: row.last_verified as string | null,
      source: row.source as string,
      status: row.status as RuleStatus,
      at: row.at as string,
      quarantinedAt: (row.quarantined_at as string | null | undefined) ?? null,
    };
  }

  listLearningRules(app: string, limit = 20): LearningRule[] {
    return (this.listRules.all(app, limit) as Array<Record<string, unknown>>).map((row) => this.rowToRule(row));
  }

  /*
   * Direct by-id read of one app's rule, uncapped and unordered: the lookup for a fold that already knows the exact rule id. A rule
   * ranked outside the ledger window still resolves here. Undefined when the row does not exist or belongs to another app.
   */
  getLearningRule(app: string, id: string): LearningRule | undefined {
    const row = this.getAppRule.get(app, id) as Record<string, unknown> | undefined;
    return row ? this.rowToRule(row) : undefined;
  }

  /*
   * Governance-only read: every active and candidate row for the app, unordered and uncapped. Pre-ranking or truncating here would be a
   * less-informed copy of governance's own ranking, and an unordered cap silently keeps the OLDEST rows.
   */
  listLearningRulesForGovernance(app: string): LearningRule[] {
    return (this.listRetrievableRules.all(app) as Array<Record<string, unknown>>).map((row) => this.rowToRule(row));
  }

  /*
   * ALL rules regardless of status: used only by the distiller for de-duplication, so a recurring failure pattern cannot spawn a
   * duplicate candidate for a rule that was demoted or superseded. Retrieval must not use this.
   */
  listAllLearningRules(app: string, limit = 200): LearningRule[] {
    return (this.listAllRules.all(app, limit) as Array<Record<string, unknown>>).map((row) => this.rowToRule(row));
  }

  incrementRuleUsage(ruleIds: string[]): void {
    if (ruleIds.length === 0) return;
    this.db.write(() => {
      for (const id of ruleIds) this.incrementUsage.run(id);
    });
  }

  /*
   * Folds one run outcome onto a rule. Only a retrievable rule (active/candidate) folds: a deprecated or superseded rule is never
   * retrieved, so an outcome can reach one only when a governance decision retired it after the run retrieved it. Folding that outcome
   * would let the outcome loop undo the decision, so a retired rule accrues nothing and keeps its status until a human restores it.
   */
  recordRuleOutcome(ruleId: string, score: number, coverageCreditConfirmed: boolean | null = null, isOracleScore = false): void {
    this.db.write(() => {
      const row = this.getRule.get(ruleId) as Record<string, unknown> | undefined;
      if (!row) return;
      const current = this.rowToRule(row);
      if (current.status !== "active" && current.status !== "candidate") return;
      /* A rule an operator set aside accrues nothing, even for a run that retrieved it before the quarantine. */
      if (current.quarantinedAt) return;
      /* The cast on the way out is real: the fold's errorClass is the wider `string`, narrower than this shell's ErrorClass union. */
      const updated = foldApplyOutcome(current, score, coverageCreditConfirmed, isOracleScore) as LearningRule;
      this.foldRule.run(updated.successRate, updated.outcomeCount, updated.oracleOutcomeCount, updated.confidence, updated.status, new Date().toISOString(), ruleId);
    });
  }

  /*
   * Human-initiated governance override: veto a rule (force it to 'deprecated') or restore a previously-vetoed one ('active'). The
   * highest-authority signal in the ledger and the only write to learning_rules that originates outside the deterministic distiller,
   * reached by an operator via the ledger CLI, never by the agent. A veto sticks: recordRuleOutcome refuses to fold onto a deprecated
   * rule, so it never auto-resurrects. Returns false when the rule id is unknown.
   */
  setRuleStatusByHuman(ruleId: string, status: "deprecated" | "active"): boolean {
    return this.db.write(() => this.setStatus.run(status, new Date().toISOString(), ruleId).changes > 0);
  }

  /*
   * Operator quarantine (npm run learning:quarantine): sets the named rules of ONE app aside without deleting them. A quarantined rule
   * is excluded from every retrieval and refused by recordRuleOutcome. Only rules not yet quarantined are marked, so the first mark is
   * kept. Returns how many rules this call newly marked.
   */
  quarantineLearningRules(app: string, ruleIds: readonly string[], at: string): number {
    return this.db.write(() => {
      let marked = 0;
      for (const id of ruleIds) marked += this.quarantine.run(at, app, id).changes;
      return marked;
    });
  }

  /* Lifts a quarantine: the rule is in force again. False when the rule is unknown or was not quarantined. */
  releaseLearningRuleQuarantine(ruleId: string): boolean {
    return this.db.write(() => this.releaseQuarantine.run(ruleId).changes > 0);
  }

  loadCurriculum(app: string): Curriculum | null | typeof CURRICULUM_CORRUPT {
    const row = this.loadCurriculumRow.get(app) as { data: string; updated_at: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as Curriculum;
    } catch (err) {
      logJson("warn", `corrupt curriculum row for app '${app}' — refusing to silently reset it with a fresh curriculum`, {
        app,
        error: redactionPort.redactError(err),
      });
      return CURRICULUM_CORRUPT;
    }
  }

  saveCurriculum(curriculum: Curriculum): void {
    this.db.write(() => this.saveCurriculumRow.run(curriculum.app, JSON.stringify(curriculum), curriculum.updatedAt));
  }

  loadScorecard(app: string): Scorecard | null {
    const row = this.loadScorecardRow.get(app) as { data: string } | undefined;
    if (!row) return null;
    return parseJsonColumn<Scorecard | null>(row.data, null, { table: "scorecard", column: "data", id: app });
  }

  /*
   * Appends one oracle outcome to the app's versioned scorecard (the proof-of-improvement record: avg/last valueScore over runs).
   * Aggregation is the pure updateScorecard; this is the DB sink.
   */
  saveScorecardEntry(entry: ScorecardEntry): void {
    this.db.write(() => {
      const sc = updateScorecard(this.loadScorecard(entry.app), entry);
      this.saveScorecardRow.run(sc.app, JSON.stringify(sc), sc.updatedAt);
    });
  }
}
