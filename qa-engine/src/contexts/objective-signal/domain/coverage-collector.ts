import type { CandidateValue, ValueStats } from "./fault-injection-score.ts";
import type { DecisionKind } from "@kernel/changed-decision.ts";

export interface CoveredLines { file: string; lines: number[]; }

/* What a browser coverage collection saw of the scripts a page ran: how many, and how many carried a source map that translates them back to the repository's files. Absent for a collector that reads native reports. */
export interface CoverageScripts { total: number; withSourceMap: number; }
/* The decision kinds are the static listing's: a measured decision and a listed one are of the same taxonomy. */
export type BranchKind = DecisionKind;
export interface BranchArm { label: string; taken: boolean; }
/* One decision of a changed file the executed code holds: where its condition is (1-based line, 0-based column), its kind, and whether each arm ran in at least one test. */
export interface BranchHit { file: string; line: number; column: number; kind: BranchKind; arms: BranchArm[]; }
/* A place of a changed file where the served script can be mutated: the exact edit of the script (identified by its URL and the sha256 of its text), the text it replaces, what it does, and the dumps (one per test) that ran it. */
export interface MutationSite {
  file: string;
  line: number;
  column: number;
  operator: string;
  script: { url: string; sha256: string };
  edit: { start: number; end: number; replacement: string };
  original: string;
  ranIn: string[];
}
/* The edit a mutant made to one served script, enough to undo it in what a page ran: the script's URL and the sha256 of its text before the edit, the edit, and the text it replaced. */
export interface MutantEdit { url: string; sha256: string; edit: MutationSite["edit"]; original: string; }
/* A mutant a test noticed: the dumps its re-run wrote (under `namespace`, by the tests of `specFiles` that failed) ran the changed code the mutant forced, and a test checked what that code did. */
export interface MutantProof extends MutantEdit { namespace: string; specFiles: string[]; }
/* `branches` and `mutationSites` are absent when the collector does not see decisions, or could not read them within its bounds. `executable` holds the lines of the changed files the loaded scripts hold code for, ran or not; absent when the collector cannot tell (a native report), and then every added line counts. */
export interface CoverageReport { covered: CoveredLines[]; executable?: CoveredLines[]; scripts?: CoverageScripts; branches?: BranchHit[]; mutationSites?: MutationSite[]; /* A source of a recollection yielded no dump: the report is a part of what it was asked for. */ incomplete?: true; }
/* The dumps of one namespace a recollection adds: without those the tests of `exceptSpecFiles` wrote, and, when `onlySpecFiles` is given, only those its tests wrote; `mutant` is the edit the page's script carried when they were written, undone before they are read. */
export interface DumpSource { namespace: string; exceptSpecFiles?: readonly string[]; onlySpecFiles?: readonly string[]; mutant?: MutantEdit; }
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
/* A mutant no test noticed: where it was applied and the mutation. `specFiles` are the spec files whose tests reached the line (the ones that ran the mutated code and checked nothing that depended on it); `original` and `replacement` are the text before and after the edit, on one line and cut. */
export interface SurvivedMutant { file: string; line: number; operator: string; specFiles?: string[]; original?: string; replacement?: string; }
/* `survivorRuns` holds, in the order of `survived`, each survivor's mutant as it was run, so it can be applied again; it carries the served script's address and edit, and stays with the orchestrator. */
export interface BundleMutationResult { applied: number; killed: number; survived: SurvivedMutant[]; proofs?: MutantProof[]; survivorRuns?: MutantRun[]; }
