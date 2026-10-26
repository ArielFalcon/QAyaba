/*
 * The restore point of the spec bytes a regeneration may change. A regeneration that is not accepted has its prior bytes put
 * back exactly, so the bytes on disk always equal the last bytes that executed green. The restore point is taken before the
 * turn is sent; the restore runs only after the transport has reported the turn finished, so a still-running session cannot
 * write after the read. It is a different thing from the per-run spec snapshot the kernel keeps for grading.
 */

/** The pre-turn bytes of the specs a regeneration may touch, keyed by spec-relative path. A file that did not exist at snapshot time is simply not present. */
export interface SuiteRestorePoint {
  readonly files: ReadonlyMap<string, Uint8Array>;
}
