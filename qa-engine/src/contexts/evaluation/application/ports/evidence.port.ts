import type { RunEvaluationEvidence } from "../../domain/run-evaluation-evidence.ts";

export interface EvidencePort {
  /* Undefined: no such run. */
  load(runId: string): Promise<RunEvaluationEvidence | undefined>;
}
