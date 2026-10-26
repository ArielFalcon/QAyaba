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
