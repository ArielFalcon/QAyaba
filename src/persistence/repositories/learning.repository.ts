import type { ErrorClass } from "@kernel/error-class";
import type { RunMode, RunOutcome, RunRecord, RunVerdict, TestTarget } from "../types";
import type { HistoryDatabase } from "../database";
import { parseJsonColumn } from "../json-column";

const EMPTY_GATE_SIGNALS: RunOutcome["gateSignals"] = { static: false, coverageRatio: null, reviewerCorrections: [], flaky: false, retries: 0 };

/* What a run ended with: run_outcomes (append-only). */
export class LearningRepository {
  private readonly insertOutcome;
  private readonly reclassifyOutcome;
  private readonly listOutcomes;
  private readonly getOutcome;

  constructor(private readonly db: HistoryDatabase) {
    const raw = db.raw;
    this.insertOutcome = raw.prepare(`
      INSERT INTO run_outcomes (id, app, sha, mode, target, verdict, error_class, gate_signals, at)
      VALUES (@id, @app, @sha, @mode, @target, @verdict, @errorClass, @gateSignals, @at)
    `);
    this.reclassifyOutcome = raw.prepare("UPDATE run_outcomes SET verdict = 'infra-error', error_class = ? WHERE id = ?");
    this.listOutcomes = raw.prepare("SELECT * FROM run_outcomes WHERE app = ? ORDER BY at DESC, rowid DESC LIMIT ?");
    this.getOutcome = raw.prepare("SELECT * FROM run_outcomes WHERE id = ?");
  }

  /* Removes an app's run outcomes. */
  deleteApp(app: string): void {
    this.db.write(() => {
      this.db.statement("DELETE FROM run_outcomes WHERE app = ?").run(app);
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

}
