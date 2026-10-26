import type { CandidateValue, ValueStats } from "./fault-injection-score.ts";

export interface CoveredLines { file: string; lines: number[]; }

/* What a browser coverage collection saw of the scripts a page ran: how many, and how many carried a source map that translates them back to the repository's files. Absent for a collector that reads native reports. */
export interface CoverageScripts { total: number; withSourceMap: number; }
export type BranchKind = "if" | "conditional" | "logical" | "switch";
export interface BranchArm { label: string; taken: boolean; }
/* One decision of a changed file the executed code holds: where its condition is (1-based line, 0-based column), its kind, and whether each arm ran in at least one test. */
export interface BranchHit { file: string; line: number; column: number; kind: BranchKind; arms: BranchArm[]; }
/* A place of a changed file where the served script can be mutated: the exact edit of the script (identified by its URL and the sha256 of its text), what it does, and the dumps (one per test) that ran it. */
export interface MutationSite {
  file: string;
  line: number;
  column: number;
  operator: string;
  script: { url: string; sha256: string };
  edit: { start: number; end: number; replacement: string };
  ranIn: string[];
}
/* `branches` and `mutationSites` are absent when the collector does not see decisions, or could not read them within its bounds. */
export interface CoverageReport { covered: CoveredLines[]; scripts?: CoverageScripts; branches?: BranchHit[]; mutationSites?: MutationSite[]; }
/* The dumps of one namespace a recollection adds, without those the tests of `exceptSpecFiles` wrote. */
export interface DumpSource { namespace: string; exceptSpecFiles?: readonly string[]; }
export interface ValueOracleResult {
  valueScore: number | null;
  /* null when the oracle ran but produced no mutation/fault-injection count (e.g. it is wired off) —
   * distinct from a genuine measured zero. Never fabricated as 0. */
  mutantCount: number | null;
  killedCount: number | null;
  details: string;
  /** The score per use case the change makes testable, when the oracle was aimed at some; absent otherwise. */
  perCandidate?: CandidateValue[];
  /** What the re-run counted, for the calibration of the score; absent when it measured nothing. */
  stats?: ValueStats;
}
/* A mutant of the served script to re-run, with the spec files whose tests reached it. */
export interface MutantRun { site: MutationSite; specFiles: string[]; }
/* What the mutants did: how many reached a page and were judged, how many a test noticed, and where the others are. */
export interface BundleMutationResult { applied: number; killed: number; survived: { file: string; line: number; operator: string }[]; }
