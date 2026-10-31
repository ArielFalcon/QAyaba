import type { PageDataRead } from "@kernel/page-data-read.ts";
import type { ServedVersionState } from "@kernel/served-version.ts";
import type { LessonsSignal } from "@kernel/lessons-signal.ts";

/** What a run hands over when it has read pages of DEV: the reads, and what the run was (never how it ended). */
export interface LessonRecording {
  app: string;
  runId: string;
  sha: string;
  /** The anchor repo of the run's change: the served-version state is its. */
  repo: string;
  servedState: ServedVersionState;
  /** ISO time of the reads. */
  at: string;
  reads: readonly PageDataRead[];
}

/** Off-path, fault-isolated by the caller. Absent means the run records nothing. */
export interface LessonRecorderPort {
  /** Records every read as an observation and returns how many there were and why each left-out one was. */
  record(recording: LessonRecording): Promise<Pick<LessonsSignal, "observed" | "leftOut">>;
}
