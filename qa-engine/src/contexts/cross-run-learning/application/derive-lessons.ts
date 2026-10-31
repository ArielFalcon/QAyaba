import { deriveLessons, LESSON_KINDS } from "../domain/lesson-registry.ts";
import type { Lesson } from "../domain/lesson-kinds.ts";
import type { LessonStorePort } from "./ports/lesson-store.port.ts";
import type { LessonsPort } from "./ports/lessons.port.ts";

/** A lesson is derived when it is asked for and never stored: a pure function of the admitted rows before the run's start. */
export class DeriveLessons implements LessonsPort {
  constructor(private readonly store: LessonStorePort) {}

  async derive(query: Parameters<LessonsPort["derive"]>[0]): Promise<readonly Lesson[]> {
    if (query.scopes.length === 0) return [];
    return deriveLessons(await this.store.listAdmitted({ ...query, kinds: LESSON_KINDS.map((kind) => kind.id) }));
  }
}
