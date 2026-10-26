import { logJson } from "../../../integrations/logger";
import type { HistoryDatabase } from "../database";
import { parseJsonColumn } from "../json-column";
import { scoreValueOf } from "../score-value";

export interface ScoreRow {
  runId: string;
  name: string;
  graderVersion: string;
  dataType: string;
  polarity: string;
  source: string;
  value: number | boolean | string;
  comment: string | null;
  observationId: string | null;
  /* LLM-judge scores only. */
  judgeModel?: string | null;
}

export interface RegradeJobRow {
  jobId: string;
  status: string;
  runIds: string[];
  graders: string[] | null;
  runs: number;
  graded: number;
  failed: Array<{ runId: string; error: string }>;
  startedAt: string;
  finishedAt: string | null;
}

/* Grading results: run_scores, run_evaluations and regrade_jobs. */
export class EvaluationRepository {
  private readonly upsertScore;
  private readonly deleteAllScores;
  private readonly deleteNamedScores;
  private readonly scoresOfRun;
  private readonly setStatus;
  private readonly getStatus;
  private readonly upsertJob;
  private readonly getJob;
  private readonly failOpenJobs;

  constructor(private readonly db: HistoryDatabase) {
    const raw = db.raw;
    this.upsertScore = raw.prepare(`
      INSERT INTO run_scores (run_id, name, grader_version, data_type, polarity, source, value, comment, observation_id, graded_at, judge_model)
      VALUES (@runId, @name, @graderVersion, @dataType, @polarity, @source, @value, @comment, @observationId, @gradedAt, @judgeModel)
      ON CONFLICT(run_id, name, grader_version) DO UPDATE SET
        data_type = excluded.data_type, polarity = excluded.polarity, source = excluded.source, value = excluded.value,
        comment = excluded.comment, observation_id = excluded.observation_id, graded_at = excluded.graded_at, judge_model = excluded.judge_model`);
    this.deleteAllScores = raw.prepare("DELETE FROM run_scores WHERE run_id = ? AND grader_version = ?");
    /* substr, not LIKE: the underscore in a score name is a LIKE wildcard. */
    this.deleteNamedScores = raw.prepare("DELETE FROM run_scores WHERE run_id = ? AND grader_version = ? AND (name = ? OR substr(name, 1, ?) = ?)");
    this.scoresOfRun = raw.prepare("SELECT * FROM run_scores WHERE run_id = ? ORDER BY name, grader_version");
    this.setStatus = raw.prepare(
      "INSERT INTO run_evaluations (run_id, status, updated_at) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
    );
    this.getStatus = raw.prepare("SELECT status FROM run_evaluations WHERE run_id = ?");
    this.upsertJob = raw.prepare(`
      INSERT INTO regrade_jobs (job_id, status, run_ids, graders, runs, graded, failed, started_at, finished_at)
      VALUES (@jobId, @status, @runIds, @graders, @runs, @graded, @failed, @startedAt, @finishedAt)
      ON CONFLICT(job_id) DO UPDATE SET status = excluded.status, graded = excluded.graded, failed = excluded.failed, finished_at = excluded.finished_at`);
    this.getJob = raw.prepare("SELECT * FROM regrade_jobs WHERE job_id = ?");
    this.failOpenJobs = raw.prepare(
      "UPDATE regrade_jobs SET status = 'failed', finished_at = ?, failed = json_insert(failed, '$[#]', json_object('runId', '', 'error', 'process restarted while the job was open')) WHERE status IN ('pending', 'running')",
    );
  }

  /*
   * Stores scores in one transaction. First it deletes what the regrade supersedes (a name the graders no longer emit must not
   * outlive it): every row of the run at `graderVersion`, or only the given base names and their `.<suffix>` expansions. Then it
   * inserts. The key is (run, name, grader version).
   */
  replaceRunScores(rows: readonly ScoreRow[], gradedAt: string, scope?: { runId: string; graderVersion: string; baseNames?: readonly string[] }): void {
    this.db.write(() => {
      if (scope) {
        if (scope.baseNames) {
          for (const base of scope.baseNames) this.deleteNamedScores.run(scope.runId, scope.graderVersion, base, base.length + 1, `${base}.`);
        } else {
          this.deleteAllScores.run(scope.runId, scope.graderVersion);
        }
      }
      for (const r of rows) this.upsertScore.run({ ...r, judgeModel: r.judgeModel ?? null, value: JSON.stringify(r.value), gradedAt });
    });
  }

  /* A stored value must be of the type its row declares; a row that is not is skipped and said, never shipped as an empty or wrong value. */
  listRunScoreRows(runId: string): ScoreRow[] {
    const rows = this.scoresOfRun.all(runId) as Array<Record<string, unknown>>;
    const out: ScoreRow[] = [];
    for (const r of rows) {
      const value = scoreValueOf(r.value as string, r.data_type as string);
      if (value === undefined) {
        logJson("error", `[evaluation] skipping a corrupt score row: run ${runId}, ${String(r.name)}@${String(r.grader_version)} (${String(r.data_type)})`);
        continue;
      }
      out.push({
        runId: r.run_id as string,
        name: r.name as string,
        graderVersion: r.grader_version as string,
        dataType: r.data_type as string,
        polarity: r.polarity as string,
        source: r.source as string,
        value,
        comment: (r.comment as string | null) ?? null,
        observationId: (r.observation_id as string | null) ?? null,
        judgeModel: (r.judge_model as string | null) ?? null,
      });
    }
    return out;
  }

  setRunEvaluationStatus(runId: string, status: string, at: string): void {
    this.db.write(() => this.setStatus.run(runId, status, at));
  }

  /* Null: the run was never graded. */
  getRunEvaluationStatus(runId: string): string | null {
    return (this.getStatus.get(runId) as { status: string } | undefined)?.status ?? null;
  }

  saveRegradeJob(job: RegradeJobRow): void {
    this.db.write(() =>
      this.upsertJob.run({ ...job, runIds: JSON.stringify(job.runIds), graders: job.graders ? JSON.stringify(job.graders) : null, failed: JSON.stringify(job.failed) }),
    );
  }

  getRegradeJob(jobId: string): RegradeJobRow | undefined {
    const r = this.getJob.get(jobId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const site = (column: string) => ({ table: "regrade_jobs", column, id: jobId });
    return {
      jobId: r.job_id as string,
      status: r.status as string,
      runIds: parseJsonColumn<string[]>(r.run_ids as string, [], site("run_ids")),
      graders: typeof r.graders === "string" ? parseJsonColumn<string[] | null>(r.graders, null, site("graders")) : null,
      runs: r.runs as number,
      graded: r.graded as number,
      failed: parseJsonColumn<Array<{ runId: string; error: string }>>(r.failed as string, [], site("failed")),
      startedAt: r.started_at as string,
      finishedAt: (r.finished_at as string | null) ?? null,
    };
  }

  /* A job a previous process left pending or running will never finish: it ends failed, with the reason. Returns how many. */
  failInterruptedRegradeJobs(at: string): number {
    return this.db.write(() => this.failOpenJobs.run(at).changes);
  }
}
