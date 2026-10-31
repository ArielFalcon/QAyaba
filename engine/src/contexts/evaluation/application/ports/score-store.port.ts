import type { Score } from "../../domain/score.ts";
import type { EvaluationStatus } from "../../domain/evidence.ts";

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
