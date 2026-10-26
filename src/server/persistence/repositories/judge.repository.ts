import type { HistoryDatabase } from "../database";
import { scoreValueOf } from "../score-value";

export interface JudgeAttemptRow {
  runId: string;
  judge: string;
  promptVersion: string;
  model: string | null;
  outcome: string;
  tokens: number;
  detail: string | null;
  at: string;
}

export interface JudgeCalibrationRow {
  judge: string;
  promptVersion: string;
  model: string;
  trainN: number;
  devN: number;
  testN: number;
  tpr: number | null;
  tnr: number | null;
  agreement: number | null;
  status: string;
  /* The full report as JSON. */
  report: string;
  computedAt: string;
}

export interface JudgeLabelPairs {
  graderVersion: string;
  model: string;
  pairs: Array<{ runId: string; human: number | boolean | string; judge: number | boolean | string }>;
}

/* LLM-judge bookkeeping: judge_attempts and judge_calibrations. The label pairs read run_scores, which the evaluation repository owns. */
export class JudgeRepository {
  private readonly insertAttempt;
  private readonly lastOutcome;
  private readonly latestModel;
  private readonly tokensUsed;
  private readonly outcomeCounts;
  private readonly insertCalibration;
  private readonly latestCalibration;
  private readonly newestJudgeScore;
  private readonly judgeScores;
  private readonly humanLabels;

  constructor(private readonly db: HistoryDatabase) {
    const raw = db.raw;
    this.insertAttempt = raw.prepare(
      "INSERT INTO judge_attempts (run_id, judge, prompt_version, model, outcome, tokens, detail, at) VALUES (@runId, @judge, @promptVersion, @model, @outcome, @tokens, @detail, @at)",
    );
    this.lastOutcome = raw.prepare("SELECT outcome FROM judge_attempts WHERE run_id = ? AND judge = ? AND prompt_version = ? ORDER BY id DESC LIMIT 1");
    this.latestModel = raw.prepare("SELECT model FROM judge_attempts WHERE judge = ? AND prompt_version = ? AND outcome = 'scored' AND model IS NOT NULL ORDER BY id DESC LIMIT 1");
    this.tokensUsed = raw.prepare("SELECT COALESCE(SUM(tokens), 0) AS used FROM judge_attempts WHERE substr(at, 1, 10) = ?");
    this.outcomeCounts = raw.prepare("SELECT outcome, COUNT(*) AS n FROM judge_attempts WHERE judge = ? AND at >= ? GROUP BY outcome");
    this.insertCalibration = raw.prepare(
      `INSERT INTO judge_calibrations (judge, prompt_version, model, train_n, dev_n, test_n, tpr, tnr, agreement, status, report, computed_at)
       VALUES (@judge, @promptVersion, @model, @trainN, @devN, @testN, @tpr, @tnr, @agreement, @status, @report, @computedAt)`,
    );
    this.latestCalibration = raw.prepare("SELECT * FROM judge_calibrations WHERE judge = ? AND prompt_version = ? ORDER BY id DESC LIMIT 1");
    this.newestJudgeScore = raw.prepare("SELECT grader_version, judge_model FROM run_scores WHERE name = ? AND source = 'llm_judge' ORDER BY graded_at DESC, rowid DESC LIMIT 1");
    this.judgeScores = raw.prepare("SELECT run_id, value, data_type FROM run_scores WHERE name = ? AND source = 'llm_judge' AND grader_version = ? AND judge_model IS ?");
    this.humanLabels = raw.prepare("SELECT run_id, value, data_type FROM run_scores WHERE name = ? AND source = 'human'");
  }

  insertJudgeAttempt(row: JudgeAttemptRow): void {
    this.db.write(() => this.insertAttempt.run(row));
  }

  /* The newest outcome recorded for the run, judge and prompt version; undefined when never attempted. */
  lastJudgeOutcome(runId: string, judge: string, promptVersion: string): string | undefined {
    return (this.lastOutcome.get(runId, judge, promptVersion) as { outcome: string } | undefined)?.outcome;
  }

  /* The model that answered the judge's newest scored attempt of the prompt version; undefined when it has none. */
  latestJudgeModel(judge: string, promptVersion: string): string | undefined {
    return (this.latestModel.get(judge, promptVersion) as { model: string } | undefined)?.model;
  }

  /* Tokens the judge attempts of a UTC day (YYYY-MM-DD) used. */
  judgeTokensUsedOn(day: string): number {
    return (this.tokensUsed.get(day) as { used: number }).used;
  }

  /* How many attempts ended each way over the window starting at `sinceIso`: the count of unparseable replies is what a judge's prompt author reads. */
  judgeOutcomeCounts(judge: string, sinceIso: string): Record<string, number> {
    const rows = this.outcomeCounts.all(judge, sinceIso) as Array<{ outcome: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.outcome, r.n]));
  }

  insertJudgeCalibration(row: JudgeCalibrationRow): void {
    this.db.write(() => this.insertCalibration.run(row));
  }

  /* The newest calibration of the judge for exactly this prompt version. */
  latestJudgeCalibration(judge: string, promptVersion: string): JudgeCalibrationRow | undefined {
    const r = this.latestCalibration.get(judge, promptVersion) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      judge: r.judge as string,
      promptVersion: r.prompt_version as string,
      model: r.model as string,
      trainN: r.train_n as number,
      devN: r.dev_n as number,
      testN: r.test_n as number,
      tpr: (r.tpr as number | null) ?? null,
      tnr: (r.tnr as number | null) ?? null,
      agreement: (r.agreement as number | null) ?? null,
      status: r.status as string,
      report: r.report as string,
      computedAt: r.computed_at as string,
    };
  }

  /*
   * The scores of the judge's newest (grader version, model) group paired with the human labels of the same runs. "Newest" is the group
   * with the latest graded_at: a judge whose prompt or model changed is calibrated for what it is now, never for what it was.
   */
  listJudgeLabelPairs(judge: string): JudgeLabelPairs | undefined {
    const newest = this.newestJudgeScore.get(judge) as { grader_version: string; judge_model: string | null } | undefined;
    if (!newest) return undefined;
    const judged = this.judgeScores.all(judge, newest.grader_version, newest.judge_model) as Array<{ run_id: string; value: string; data_type: string }>;
    const labels = new Map((this.humanLabels.all(judge) as Array<{ run_id: string; value: string; data_type: string }>).map((r) => [r.run_id, r]));
    const pairs: JudgeLabelPairs["pairs"] = [];
    for (const j of judged) {
      const human = labels.get(j.run_id);
      if (!human) continue;
      const humanValue = scoreValueOf(human.value, human.data_type);
      const judgeValue = scoreValueOf(j.value, j.data_type);
      if (humanValue !== undefined && judgeValue !== undefined) pairs.push({ runId: j.run_id, human: humanValue, judge: judgeValue });
    }
    return { graderVersion: newest.grader_version, model: newest.judge_model ?? "unknown", pairs };
  }
}
