import type { SkippedSites } from "./select-mutants.ts";
import type { SurvivedMutant } from "./coverage-collector.ts";
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
  /** Changed lines the loaded scripts hold no code for (imports, types, comments): left out of `changedLines`. Absent when the collector cannot tell. */
  notExecutableLines?: number;
  /** Changed files no loaded script maps: their non-blank lines are counted, and uncovered. */
  notLoadedFiles?: string[];
  /** With a killed mutant's dumps added: the covered lines the passing tests ran by themselves, and the lines and arms only a killed mutant's re-run ran. `coveredChanged` holds both. */
  coveredByExecution?: number;
  provenByMutation?: number;
  armsProvenByMutation?: number;
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

/** What the mutants of the changed code in the served script did: judged, noticed by a test, and where the others are; the sites on changed lines a test reached that were no candidate, counted by why (`skippedSites`, absent when none was); and how many mutants re-ran every test of their spec files because the tests that reached them could not be told (`rerunsBySpecFile`, absent when none did). */
export interface BundleMutationOutcome {
  applied: number;
  killed: number;
  survived: SurvivedMutant[];
  skippedSites?: SkippedSites;
  rerunsBySpecFile?: number;
}

/** How the mutants of a measurement were chosen: the sites left out by why (absent when none was), and how many mutants re-run only the tests that reached them and how many every test of their spec files. */
export interface MutantSelectionRecord {
  skippedSites?: SkippedSites;
  rerunsByTest: number;
  rerunsBySpecFile: number;
}

/** The dumps a re-run of some spec files wrote, under its own namespace. Only the dumps of `specFiles` are read from it: a spec the same execution ran whose bytes were then given back left dumps there that describe nothing on disk. */
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
