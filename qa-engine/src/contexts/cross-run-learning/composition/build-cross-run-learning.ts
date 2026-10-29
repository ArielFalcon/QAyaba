/* Builds the cross-run-learning context: the curriculum and process-audit ports the shell supplies. */

import type { CurriculumPort, ProcessAuditPort } from "../application/index.ts";

export interface CrossRunLearningDeps {
  curriculum?: CurriculumPort;
  processAudit?: ProcessAuditPort;
}

export interface CrossRunLearningApi {
  /* Each port is served only when supplied: never a fabricated no-op stub. */
  curriculum?: CurriculumPort;
  processAudit?: ProcessAuditPort;
}

export function buildCrossRunLearning(deps: CrossRunLearningDeps): CrossRunLearningApi {
  return {
    ...(deps.curriculum ? { curriculum: deps.curriculum } : {}),
    ...(deps.processAudit ? { processAudit: deps.processAudit } : {}),
  };
}
