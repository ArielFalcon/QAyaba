export type EvaluationStatus = "pending" | "complete" | "failed";

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
