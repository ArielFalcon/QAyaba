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

export type BranchCasesAction = "regenerate" | "keep";

export interface BranchCasesInput {
  /** The run executed green, so there is a measurement to act on. */
  measured: boolean;
  /** The measurement blocks publication: the coverage regeneration then carries the same arms in its gap. */
  blocks: boolean;
  /** Only a per-commit diff run on one repo has a real signal to repair. */
  perCommit: boolean;
  /** The branch cases are configured on. */
  enabled: boolean;
  /** The arms of the changed code no test ran. */
  untakenArms: number;
}

/* The one regeneration from the arms no test ran: it never blocks, so it runs only where the coverage regeneration does not and only with arms to cover. The step runs once per run. */
export function branchCasesAction({ measured, blocks, perCommit, enabled, untakenArms }: BranchCasesInput): BranchCasesAction {
  return measured && perCommit && !blocks && enabled && untakenArms > 0 ? "regenerate" : "keep";
}
