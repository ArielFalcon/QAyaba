import type { AggregateUnmeasured, CandidateCoverage } from "./per-candidate-coverage.ts";

/** What a change-coverage measurement counted, and why a measurement that decides nothing did not. */
export interface CoverageMeasurement {
  changedLines: number;
  coveredChanged: number;
  changedFiles: number;
  /** Changed files the executed code was mapped to. */
  mappedFiles: number;
  /** Why the measurement decides nothing: no diff, no assembler, no changed line, or no executed source mapped to a changed file, or the scripts the page ran carried no source map at all (the app serves bundles that cannot be translated back to the repository's files). Absent when it measured. */
  /** The share of each use case's changed lines the run executed, or why it has none; absent when no candidates were asked for. A signal beside the aggregate, which alone decides. */
  perCandidate?: CandidateCoverage[];
  unmeasured?: AggregateUnmeasured;
}
