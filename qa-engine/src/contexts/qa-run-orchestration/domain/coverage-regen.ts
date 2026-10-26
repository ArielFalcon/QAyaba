/*
 * Whether a measurement that blocks publication earns the one coverage regeneration. Pure: no I/O, no clock. The mode and the
 * status are read by the objective-signal port (`blocks`), the single source of truth for blocking; this only counts.
 */

export type CoverageRegenAction = "regenerate" | "keep";

export interface CoverageRegenInput {
  /** The run executed green, so there is a measurement to act on. */
  measured: boolean;
  /** The port's own reading of the mode and the status: only an enforced failure blocks. */
  blocks: boolean;
  /** Only a per-commit diff run on one repo has a real signal to repair. */
  perCommit: boolean;
  /** Coverage regenerations spent so far. */
  regenerated: number;
}

export const MAX_COVERAGE_REGENERATIONS = 1;

export function coverageRegenAction({ measured, blocks, perCommit, regenerated }: CoverageRegenInput): CoverageRegenAction {
  return measured && blocks && perCommit && regenerated < MAX_COVERAGE_REGENERATIONS ? "regenerate" : "keep";
}
