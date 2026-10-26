import type { BlastRadius } from "@kernel/blast-radius.ts";

/** What a change-coverage measurement counted, and why a measurement that decides nothing did not. */
export interface CoverageMeasurement {
  changedLines: number;
  coveredChanged: number;
  changedFiles: number;
  /** Changed files the executed code was mapped to. */
  mappedFiles: number;
  /** Why the measurement decides nothing: no diff, no assembler, no changed line, or no executed source mapped to a changed file, or the scripts the page ran carried no source map at all (the app serves bundles that cannot be translated back to the repository's files). Absent when it measured. */
  unmeasured?: "no-diff" | "not-assembled" | "no-changed-lines" | "no-changed-file-mapped" | "no-source-maps";
}

export interface ObjectiveSignalPort {
  /**
   * `valueScore` absent means not measured — never a fabricated 0.
   * `mutantCount`/`killedCount` mirror the value-oracle's own ValueOracleResult: absent means the
   * oracle never ran this measure() call (e.g. coverage.mode "off"); `null` means it ran but has no
   * count to report. Neither is ever fabricated as 0 — that would read as a genuine measured zero.
   * `diff` absent (non-diff modes) → assembler never invoked → decide() gets
   * null → "unknown" → never blocks.
   * `baselineCases` are this run's passing case names; absent falls back to the
   * static composition-time list.
   * `uncovered` is populated only when a ChangeCoverage was actually assembled;
   * never fabricated as [].
   * `opts.namespace` overrides the dump namespace for the regen's second
   * measure(); the first measurement is untouched.
   */
  measure(br: BlastRadius, specDir: string, diff?: string, baselineCases?: string[], opts?: { namespace?: string }): Promise<{ status: "pass" | "fail" | "unknown"; ratio: number | null; valueScore?: number | null; mutantCount?: number | null; killedCount?: number | null; uncovered?: { file: string; lines: number[] }[]; measurement?: CoverageMeasurement }>;
  /**
   * Single source of truth for whether a measured status blocks publish.
   * Only "enforce" + "fail" blocks; "unknown" never blocks regardless of mode.
   */
  blocks(status: "pass" | "fail" | "unknown"): boolean;
}
