/* The lesson kinds the engine knows, in the order they are read. A kind is added here and deleted here (the kill criterion of docs/architecture/rfc/0013-learning-slice.md removes its entry). */

import { DATA_VOLATILITY } from "./data-volatility.ts";
import type { Lesson, LessonKind, LessonKindId, LessonObservation } from "./lesson-kinds.ts";

export const LESSON_KINDS: readonly LessonKind[] = [DATA_VOLATILITY];

export function lessonKind(id: LessonKindId): LessonKind {
  const kind = LESSON_KINDS.find((candidate) => candidate.id === id);
  if (!kind) throw new Error(`unknown lesson kind ${id}`);
  return kind;
}

/* The lessons every kind derives from the admitted observations of one app. */
export function deriveLessons(admitted: readonly LessonObservation[]): Lesson[] {
  return LESSON_KINDS.flatMap((kind) => kind.derive(admitted.filter((observation) => observation.kind === kind.id)));
}
