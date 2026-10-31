import type { SuiteRestorePoint } from "../../domain/suite-restore-point.ts";

export interface SuiteRestorePort {
  /** Reads the current bytes of `specFiles` (through the confined reader). Throws when a file cannot be read: a snapshot that is not a faithful "before" must not stand in for the proven bytes. */
  snapshot(specDir: string, specFiles: readonly string[]): Promise<SuiteRestorePoint>;
  /** Puts the captured bytes back and removes the files the turn created. A failure throws: a half-restored suite must never be mistaken for the proven bytes. */
  restore(specDir: string, snapshot: SuiteRestorePoint, createdFiles: readonly string[]): Promise<void>;
}
