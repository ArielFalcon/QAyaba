/*
 * Snapshot and restore of the spec bytes a regeneration may change. The adapter reads through the
 * confined reader and writes back through `writeOwnedSpecFile` (removing files the turn created with
 * `removeOwnedSpecFile`): a regeneration that is not accepted has its prior bytes put back exactly,
 * so the bytes on disk always equal the last bytes that executed green. The pre-snapshot is taken
 * before the turn is sent; the restore runs only after the transport has reported the turn finished,
 * so a still-running session cannot write after the read.
 */

/** The pre-turn bytes of the specs a regeneration may touch, keyed by spec-relative path. A file that did not exist at snapshot time is simply not present. */
export interface SpecSnapshot {
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export interface SpecSnapshotPort {
  /** Reads the current bytes of `specFiles` (through the confined reader). Throws when a file cannot be read: a snapshot that is not a faithful "before" must not stand in for the proven bytes. */
  snapshot(specDir: string, specFiles: readonly string[]): Promise<SpecSnapshot>;
  /** Puts the captured bytes back and removes the files the turn created. A failure throws: a half-restored suite must never be mistaken for the proven bytes. */
  restore(specDir: string, snapshot: SpecSnapshot, createdFiles: readonly string[]): Promise<void>;
}
