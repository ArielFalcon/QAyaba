/* Builds the cross-run-learning context: the process-audit port and the lesson store the shell supplies. */

import { RecordLessonObservations, type LessonRecorderPort, type LessonStorePort, type ProcessAuditPort } from "../application/index.ts";

export interface CrossRunLearningDeps {
  processAudit?: ProcessAuditPort;
  /** The append-only record of what runs read of DEV. */
  lessonStore?: LessonStorePort;
}

export interface CrossRunLearningApi {
  /* The port is served only when supplied: never a fabricated no-op stub. */
  processAudit?: ProcessAuditPort;
  /* Served when a store is supplied: every run records what it read of DEV, frozen or not. */
  lessonRecorder?: LessonRecorderPort;
}

export function buildCrossRunLearning(deps: CrossRunLearningDeps): CrossRunLearningApi {
  return {
    ...(deps.processAudit ? { processAudit: deps.processAudit } : {}),
    ...(deps.lessonStore ? { lessonRecorder: new RecordLessonObservations(deps.lessonStore) } : {}),
  };
}
