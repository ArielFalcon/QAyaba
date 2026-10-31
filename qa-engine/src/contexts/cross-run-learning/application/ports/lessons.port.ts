import type { Lesson } from "../../domain/lesson-kinds.ts";

/** The lessons a run may be told, derived from stored observations when asked. Absent means the run reads none. */
export interface LessonsPort {
  /** The lessons of the given scopes from the observations written strictly before `before` (ISO time); identical stored rows give identical lessons. */
  derive(query: { app: string; scopes: readonly string[]; before: string }): Promise<readonly Lesson[]>;
}
