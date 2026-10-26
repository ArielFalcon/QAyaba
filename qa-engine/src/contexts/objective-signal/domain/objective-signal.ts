import type { AggregateUnmeasured, CandidateCoverage } from "./per-candidate-coverage.ts";

/** What a change-coverage measurement counted, and why a measurement that decides nothing did not. */
export interface CoverageMeasurement {
  changedLines: number;
  coveredChanged: number;
  changedFiles: number;
  /** Changed files the executed code was mapped to. */
  mappedFiles: number;
  /** Arms of the decisions on changed lines, and how many of them ran. Absent when no decision was seen on a changed line. */
  changedBranches?: number;
  takenBranches?: number;
  /** Why the measurement decides nothing: no diff, no assembler, no changed line, or no executed source mapped to a changed file, or the scripts the page ran carried no source map at all (the app serves bundles that cannot be translated back to the repository's files). Absent when it measured. */
  /** The share of each use case's changed lines the run executed, or why it has none; absent when no candidates were asked for. A signal beside the aggregate, which alone decides. */
  perCandidate?: CandidateCoverage[];
  unmeasured?: AggregateUnmeasured;
}

/** An arm of a decision on a changed line that no test ran. */
export interface UntakenArm {
  file: string;
  line: number;
  kind: string;
  arm: string;
}

/** What the mutants of the changed code in the served script did: judged, noticed by a test, and where the others are. */
export interface BundleMutationOutcome {
  applied: number;
  killed: number;
  survived: { file: string; line: number; operator: string }[];
}

/** The dumps a re-run of some spec files wrote, under its own namespace. */
export interface CoverageRerun {
  namespace: string;
  specFiles: readonly string[];
}

/** A change-coverage counted again: the same status, ratio, lines and arms a measurement reports. */
export interface CoverageRecount {
  status: "pass" | "fail" | "unknown";
  ratio: number | null;
  uncovered: { file: string; lines: number[] }[];
  untakenArms: UntakenArm[];
  measurement: CoverageMeasurement;
}
