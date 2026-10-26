import type { JudgeName } from "../../domain/judges.ts";

/* What the regrade use case needs from the judges: whether a request naming a judge can be taken, and a way to hand a run to them. */
export interface JudgeRegradePort {
  /* Why a request naming a judge cannot be taken (judges off, role missing), or undefined when it can. */
  unavailable(): string | undefined;
  /* Hands the run to the judges' low-priority job. `unavailable-run` when the run does not exist or has not finished. */
  request(runId: string, judges: readonly JudgeName[]): "scheduled" | "unavailable-run";
}
