import { CURRICULUM_CORRUPT } from "@contexts/cross-run-learning/application/index";
import type { ErrorClass } from "@kernel/error-class";
import { logJson } from "../../../integrations/logger";
import { RedactionPortAdapter } from "../../../orchestrator/sanitizer";
import type { Curriculum } from "../../../qa/learning/curriculum";
import type { Scorecard } from "../../../qa/learning/oracle-types";
import type { RunMode, RunOutcome, RunRecord, RunVerdict, TestTarget } from "../../../types";
import type { HistoryDatabase } from "../database";
import { parseJsonColumn } from "../json-column";

const redactionPort = new RedactionPortAdapter();

const EMPTY_GATE_SIGNALS: RunOutcome["gateSignals"] = { static: false, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 };

/* What a run taught: run_outcomes (append-only), the curriculum and the scorecard (read-only: nothing writes it any more). The learning_rules table and the rules_retrieved and reflection columns of run_outcomes are no longer read or written; the schema keeps them. */
export class LearningRepository {
  private readonly insertOutcome;
  private readonly reclassifyOutcome;
  private readonly listOutcomes;
  private readonly getOutcome;
  private readonly loadCurriculumRow;
  private readonly saveCurriculumRow;
  private readonly loadScorecardRow;

  constructor(private readonly db: HistoryDatabase) {
    const raw = db.raw;
    this.insertOutcome = raw.prepare(`
      INSERT INTO run_outcomes (id, app, sha, mode, target, verdict, error_class, gate_signals, at)
      VALUES (@id, @app, @sha, @mode, @target, @verdict, @errorClass, @gateSignals, @at)
    `);
    this.reclassifyOutcome = raw.prepare("UPDATE run_outcomes SET verdict = 'infra-error', error_class = ? WHERE id = ?");
    this.listOutcomes = raw.prepare("SELECT * FROM run_outcomes WHERE app = ? ORDER BY at DESC, rowid DESC LIMIT ?");
    this.getOutcome = raw.prepare("SELECT * FROM run_outcomes WHERE id = ?");
    this.loadCurriculumRow = raw.prepare("SELECT data, updated_at FROM curriculum WHERE app = ?");
    this.saveCurriculumRow = raw.prepare("INSERT INTO curriculum (app, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(app) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at");
    this.loadScorecardRow = raw.prepare("SELECT data FROM scorecard WHERE app = ?");
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
}
