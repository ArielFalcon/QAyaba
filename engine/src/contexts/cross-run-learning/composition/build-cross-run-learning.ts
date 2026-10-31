/* Builds the cross-run-learning context: the process-audit port and the lesson store the shell supplies. */

import { DeriveLessons, RecordLessonObservations, type LessonsPort, type LessonRecorderPort, type LessonStorePort, type ProcessAuditPort } from "../application/index.ts";

export interface CrossRunLearningDeps {
  processAudit?: ProcessAuditPort;
  /** The append-only record of what runs read of DEV. */
  lessonStore?: LessonStorePort;
  /** Whether this run may be told the lessons: false serves none (a frozen run writes observations and never reads lessons). */
  readLessons?: boolean;
}

export interface CrossRunLearningApi {
  /* The port is served only when supplied: never a fabricated no-op stub. */
  processAudit?: ProcessAuditPort;
  /* Served when a store is supplied: every run records what it read of DEV, frozen or not. */
  lessonRecorder?: LessonRecorderPort;
  /* Served when a store is supplied and the run may read lessons. */
  lessons?: LessonsPort;
}

export function buildCrossRunLearning(deps: CrossRunLearningDeps): CrossRunLearningApi {
  return {
    ...(deps.processAudit ? { processAudit: deps.processAudit } : {}),
    ...(deps.lessonStore ? { lessonRecorder: new RecordLessonObservations(deps.lessonStore) } : {}),
    ...(deps.lessonStore && deps.readLessons === true ? { lessons: new DeriveLessons(deps.lessonStore) } : {}),
  };
}
