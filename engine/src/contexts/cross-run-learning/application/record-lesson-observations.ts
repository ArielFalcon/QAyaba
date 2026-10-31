import { LESSON_KINDS } from "../domain/lesson-registry.ts";
import type { LeftOutReason, LessonObservation } from "../domain/lesson-kinds.ts";
import type { LessonRecorderPort, LessonRecording } from "./ports/lesson-recorder.port.ts";
import type { LessonStorePort } from "./ports/lesson-store.port.ts";

/*
 * Turns the pages a run read of DEV into observations, one per read and kind, and appends them. Every run writes its reads, frozen or not: they
 * are facts about DEV, and writing them changes nothing the run does. Admission reads the served-version state and the read's own confirmation
 * flags; the run's verdict is not an input and is not yet known.
 */
export class RecordLessonObservations implements LessonRecorderPort {
  constructor(private readonly store: LessonStorePort) {}

  async record(recording: LessonRecording): ReturnType<LessonRecorderPort["record"]> {
    const rows: LessonObservation[] = [];
    const leftOut: Record<string, number> = {};
    recording.reads.forEach((read, index) => {
      for (const kind of LESSON_KINDS) {
        const admission = kind.admit(read, recording.servedState);
        const reason: LeftOutReason | null = admission.admitted ? null : admission.reason;
        if (reason !== null) leftOut[reason] = (leftOut[reason] ?? 0) + 1;
        rows.push({
          id: `${recording.runId}#${kind.id}#${index}`,
          app: recording.app,
          runId: recording.runId,
          sha: recording.sha,
          repo: recording.repo,
          kind: kind.id,
          scope: read.scope,
          servedState: recording.servedState,
          admitted: admission.admitted,
          leftOutReason: reason,
          fact: kind.factOf(read),
          at: recording.at,
        });
      }
    });
    if (rows.length > 0) await this.store.record(rows);
    return { observed: recording.reads.length, leftOut };
  }
}
