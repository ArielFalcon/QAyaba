/* What the control API sees of the evaluation context: the port it declares, which the composition root's evaluation service (src/composition/evaluation-service.ts) implements, and the views it serves. */

import type { CampaignRunView, EvaluationStatus, RegradeJob, RegradeRequest, Score, ScoreDataType, ScorePolarity } from "@contexts/evaluation/application/index";

export interface CatalogScoreView {
  name: string;
  dataType: ScoreDataType;
  polarity: ScorePolarity;
  range?: { min: number; max?: number };
  categories?: string[];
  suffixes?: string[];
  graderVersion: string;
}

export interface RunEvaluationView {
  runId: string;
  traceId: string | null;
  status: EvaluationStatus;
  scores: Score[];
}

export interface RegradeJobView {
  jobId: string;
  status: RegradeJob["status"];
  runs: number;
  graded: number;
  failed: Array<{ runId: string; error: string }>;
  startedAt: string;
  finishedAt?: string;
}

export interface CampaignRunsView {
  campaignId: string;
  runs: Array<CampaignRunView & { restoredDigest?: string }>;
  complete: boolean;
}

/* What the runner and the API see of the evaluation context. */
export interface EvaluationService {
  /* Grades the run later, off the caller's path. Never throws, never blocks. */
  scheduleGrading(runId: string): void;
  /* Undefined: no such run. */
  evaluation(runId: string, allVersions: boolean): RunEvaluationView | undefined;
  startRegrade(request: RegradeRequest): { jobId: string; runs: number };
  regradeJob(jobId: string): RegradeJobView | undefined;
  /* The campaign's runs (narrowed to those carrying every label of `variant`) and whether they are all done and graded. */
  campaignRuns(campaignId: string, variant: Readonly<Record<string, string>>): CampaignRunsView;
  /* Boot: ends the jobs a previous process left open. */
  recoverInterrupted(): number;
  /* The score catalog: the graders. */
  catalog(): { phases: string[]; scores: CatalogScoreView[] };
}
