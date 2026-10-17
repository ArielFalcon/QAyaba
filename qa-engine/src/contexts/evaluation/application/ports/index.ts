/* The evaluation context's ports. The shell implements them over SQLite; the Langfuse sink is a later adapter. */

import type { RunEvaluationEvidence } from "../../domain/run-evaluation-evidence.ts";
import type { Score } from "../../domain/score.ts";

export type EvaluationStatus = "pending" | "complete" | "failed";

export interface EvidencePort {
  /* Undefined: no such run. */
  load(runId: string): Promise<RunEvaluationEvidence | undefined>;
}

export interface ScoreStorePort {
  /*
   * Stores the scores in one transaction. First it deletes what the regrade supersedes, so a name the graders no longer emit
   * does not outlive it: a full regrade (no `baseNames`) deletes every row of the run at `graderVersion`; a subset deletes only
   * those base names and their `.<suffix>` expansions. Then it inserts; the key is (runId, name, graderVersion).
   */
  replace(runId: string, scores: readonly Score[], gradedAt: string, scope: { graderVersion: string; baseNames?: readonly string[] }): void;
  /* Latest grader version per name, or every stored version. */
  list(runId: string, opts: { allVersions: boolean }): Score[];
  setStatus(runId: string, status: EvaluationStatus, at: string): void;
  /* Pending when the run was never graded. */
  status(runId: string): EvaluationStatus;
}

/* Where scores are mirrored to (Langfuse). Fail-open: the use case never lets a sink fault change a grade. */
export interface ScoreSinkPort {
  emit(runId: string, scores: readonly Score[], at: string): Promise<void> | void;
}

export const NO_SINK: ScoreSinkPort = { emit: () => undefined };

/* The finished runs a regrade may cover. */
export interface RunSelectorPort {
  finishedSince(sinceIso: string): string[];
  /* Campaign identity arrives with the campaign fields (slice S5); until a run carries it this answers empty. */
  ofCampaign(campaignId: string): string[];
}

export type RegradeJobStatus = "pending" | "running" | "complete" | "failed";

export interface RegradeJob {
  jobId: string;
  status: RegradeJobStatus;
  runIds: string[];
  graders: string[] | undefined;
  runs: number;
  graded: number;
  failed: Array<{ runId: string; error: string }>;
  startedAt: string;
  finishedAt: string | undefined;
}

export interface RegradeJobStorePort {
  create(job: RegradeJob): void;
  update(job: RegradeJob): void;
  get(jobId: string): RegradeJob | undefined;
}
