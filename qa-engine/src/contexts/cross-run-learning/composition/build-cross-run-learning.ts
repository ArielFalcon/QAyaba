/* Builds the cross-run-learning context: the process-audit port the shell supplies. */

import type { ProcessAuditPort } from "../application/index.ts";

export interface CrossRunLearningDeps {
  processAudit?: ProcessAuditPort;
}

export interface CrossRunLearningApi {
  /* The port is served only when supplied: never a fabricated no-op stub. */
  processAudit?: ProcessAuditPort;
}

export function buildCrossRunLearning(deps: CrossRunLearningDeps): CrossRunLearningApi {
  return {
    ...(deps.processAudit ? { processAudit: deps.processAudit } : {}),
  };
}
