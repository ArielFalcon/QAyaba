/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export { NON_LEARNING, OBSERVED_OPERATING, learningGates, observesOperatingSignal } from "../domain/learning-gates.ts";
export { LESSON_KINDS } from "../domain/lesson-registry.ts";
export type { Admission, LeftOutReason, Lesson, LessonKind, LessonKindId, LessonObservation, ObservedFact } from "../domain/lesson-kinds.ts";
export { DeriveLessons } from "./derive-lessons.ts";
export { RecordLessonObservations } from "./record-lesson-observations.ts";
export type { ProcessAuditPort } from "./ports/process-audit.port.ts";
export type { LessonRecorderPort, LessonRecording } from "./ports/lesson-recorder.port.ts";
export type { LessonStorePort } from "./ports/lesson-store.port.ts";
export type { LessonsPort } from "./ports/lessons.port.ts";
