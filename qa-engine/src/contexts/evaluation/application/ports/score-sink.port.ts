import type { Score } from "../../domain/score.ts";

/* Where scores are mirrored to (Langfuse). Fail-open: the use case never lets a sink fault change a grade. */
export interface ScoreSinkPort {
  emit(runId: string, scores: readonly Score[], at: string): Promise<void> | void;
}

export const NO_SINK: ScoreSinkPort = { emit: () => undefined };
