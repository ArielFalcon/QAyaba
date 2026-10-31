import type { LessonKindId, LessonObservation } from "../../domain/lesson-kinds.ts";

/** The append-only record of what runs read of DEV. This context never imports platform/: the shell supplies the store. */
export interface LessonStorePort {
  /** Appends the rows of one run. Rows are never updated or removed by a run. */
  record(rows: readonly LessonObservation[]): Promise<void>;
  /** The admitted observations of an app, of the given kinds, for the given scopes, written strictly before `before` (ISO time). */
  listAdmitted(query: { app: string; kinds: readonly LessonKindId[]; scopes: readonly string[]; before: string }): Promise<readonly LessonObservation[]>;
}
