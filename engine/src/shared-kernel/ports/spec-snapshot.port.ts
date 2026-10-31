/*
 * The text of the specs a run delivered, kept per run so that a run can be graded after the fact: the mirror is wiped by every checkout and the
 * suite store keeps only accepted suites, so without a snapshot nothing could re-grade an invalid or failed run (docs/observability-design.md
 * §11.1). A snapshot's text has been through the run's secret redaction and the outbound sanitizer and is capped; it is metadata for grading,
 * never read back by the engine.
 *
 * Total by contract: recording never fails a run, and the default does nothing.
 */

export const MAX_SPEC_SNAPSHOT_TEXT_BYTES = 64 * 1024;
/* The most specs one capture looks at. */
export const MAX_SPEC_SNAPSHOTS_PER_CAPTURE = 200;
/* The most snapshot text one run keeps, all its specs and versions together. */
export const MAX_SPEC_SNAPSHOT_BYTES_PER_RUN = 2 * 1024 * 1024;

export interface SpecSnapshot {
  runId: string;
  /* Relative to the suite directory. */
  path: string;
  /* Of the file's bytes as read, before redaction and the cap: it names the content that was judged. */
  sha256: string;
  /* Redacted and capped text. */
  text: string;
  /* Size of the file as read. */
  bytes: number;
  /* Wall-clock ms. */
  capturedAt: number;
  /* Whether the run delivered this spec (wrote or changed it) and did not merely find it in the suite. Only delivered specs are kept. */
  delivered: boolean;
}

export interface SpecSnapshotPort {
  record(snapshots: readonly SpecSnapshot[]): void;
}
