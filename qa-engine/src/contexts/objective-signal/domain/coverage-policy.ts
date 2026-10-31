/* What an app's `qa.changeCoverage` block decides about the objective signal, and what the engine falls back to where the app says nothing. Pure: the shell hands in the block as the app declared it. */
import type { CoverageMode } from "./decide-coverage.service.ts";

export type BranchCasesMode = "regenerate" | "off";

/* The change-coverage policy in force when the app declares none: record the measurement, block nothing. */
export const DEFAULT_COVERAGE_MODE: CoverageMode = "signal";
/* The share of the changed lines a green run must cover for the status to read `pass`. */
export const DEFAULT_COVERAGE_MIN_RATIO = 0.7;
/* A green diff run whose measurement found untaken arms gets one regeneration from them. */
export const DEFAULT_COVERAGE_BRANCH_CASES: BranchCasesMode = "regenerate";

/* The part of an app's `qa.changeCoverage` the objective signal reads. */
export interface ChangeCoverageDeclaration {
  mode?: CoverageMode | undefined;
  minRatio?: number | undefined;
  branchCases?: BranchCasesMode | undefined;
  bundleMutation?: "signal" | "off" | undefined;
}

export interface ResolvedCoveragePolicy {
  mode: CoverageMode;
  minRatio: number;
  branchCases: BranchCasesMode;
}

export function resolveCoveragePolicy(declared: ChangeCoverageDeclaration | undefined): ResolvedCoveragePolicy {
  return {
    mode: declared?.mode ?? DEFAULT_COVERAGE_MODE,
    minRatio: declared?.minRatio ?? DEFAULT_COVERAGE_MIN_RATIO,
    branchCases: declared?.branchCases ?? DEFAULT_COVERAGE_BRANCH_CASES,
  };
}

/* The mutation pass (a few mutants of the changed code in the served script, each re-run against the tests that reached it) runs for every app unless its changeCoverage turns it off, shadow or not. */
export function bundleMutationEnabled(declared: ChangeCoverageDeclaration | undefined): boolean {
  return declared?.bundleMutation !== "off";
}
