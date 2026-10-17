/*
 * Grades one run: reads its evidence, runs the deterministic graders and stores the scores. Idempotent: the store replaces a score
 * with the same (runId, name, graderVersion). It never throws: a fault becomes the run's evaluation status "failed", and a sink fault
 * changes nothing. Callers run it off the queue path (the runner schedules it; it is never awaited by a run).
 */

import { gradeEvidence } from "../domain/graders.ts";
import type { Score } from "../domain/score.ts";
import { NO_SINK, type EvidencePort, type ScoreSinkPort, type ScoreStorePort } from "./ports/index.ts";

export interface GradeRunDeps {
  evidence: EvidencePort;
  store: ScoreStorePort;
  sink?: ScoreSinkPort;
  /* Wall-clock ISO-8601 now. */
  now: () => string;
  /* A fault is said, never swallowed. */
  log?: (message: string) => void;
}

export type GradeRunResult =
  | { status: "complete"; scores: number }
  | { status: "failed"; scores: number; error: string }
  /* No such run, or it has not finished: nothing was graded and the status stays pending. */
  | { status: "skipped"; reason: "unknown-run" | "not-finished" };

export class GradeRunUseCase {
  constructor(private readonly deps: GradeRunDeps) {}

  async execute(runId: string, opts: { graders?: readonly string[] } = {}): Promise<GradeRunResult> {
    const { evidence, store, now } = this.deps;
    const log = this.deps.log ?? ((m: string) => console.error(m));
    try {
      const found = await evidence.load(runId);
      if (!found) return { status: "skipped", reason: "unknown-run" };
      if (!found.finished) return { status: "skipped", reason: "not-finished" };
      const scores: Score[] = gradeEvidence(found, opts.graders);
      const at = now();
      store.replace(runId, scores, at);
      store.setStatus(runId, "complete", at);
      await this.mirror(runId, scores, found.finishedAt, log);
      return { status: "complete", scores: scores.length };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`[evaluation] grading ${runId} failed: ${error}`);
      try {
        store.setStatus(runId, "failed", now());
      } catch (statusErr) {
        log(`[evaluation] could not record the failure of ${runId}: ${statusErr instanceof Error ? statusErr.message : String(statusErr)}`);
      }
      return { status: "failed", scores: 0, error };
    }
  }

  private async mirror(runId: string, scores: readonly Score[], at: string, log: (m: string) => void): Promise<void> {
    try {
      await (this.deps.sink ?? NO_SINK).emit(runId, scores, at);
    } catch (err) {
      log(`[evaluation] the score sink failed for ${runId} (the scores are stored): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
