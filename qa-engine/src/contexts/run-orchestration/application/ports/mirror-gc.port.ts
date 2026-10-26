/**
 * Compacts orphaned object packs on the mirror. Absent: no prune.
 * A thrown prune() MUST be caught by the caller, logged, and never alter the
 * verdict or block the run.
 */
export interface MirrorGcPort {
  prune(mirrorDir: string): Promise<void>;
}
