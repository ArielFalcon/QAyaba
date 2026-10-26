import type { JudgeEvidence } from "../../domain/judges.ts";

export interface JudgeEvidencePort {
  /* Undefined: no such run, or one that is not finished. */
  load(runId: string): JudgeEvidence | undefined;
}
