/*
 * What a run records of the lessons: how many pages it read of DEV and why the ones that taught nothing were left out. Counts only; no verdict
 * is an input to it (docs/architecture/rfc/0013-learning-slice.md).
 */

import type { LessonDelivery } from "./coordination.ts";

export interface LessonsSignal {
  /** Pages the run read under the app's declared data state, left-out reads included. */
  observed: number;
  /** The reads that were not admitted, by their one typed reason (`served-version:<state>`, `no-data-state`, `unconfirmed-read`, `not-captured`). */
  leftOut: Readonly<Record<string, number>>;
  /** The lessons a flow's brief stated, each once: its kind, the page and a digest of the line. Absent when none was delivered. */
  delivered?: LessonDelivery[];
  /** The failures whose settled failure point showed DEV's data differing from what the pack read, by page: the failed cases of the final execution and the failing tests of the flows' `run_spec` calls. Present (empty when none) for a run that executed; absent for one that did not. The measure of the lesson slice, never an input to a lesson. */
  dataStateFailures?: Array<{ path: string; count: number }>;
  /** The pages each flow of the plan was given and the spec it authors: which delivered specs a lesson on a page covers. Absent for a run that planned no flow. */
  specPages?: Array<{ spec: string; routes: string[] }>;
}
