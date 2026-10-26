/* Coverage and value-oracle ports. The keystone — unknown NEVER blocks — lives in DecideCoverageService, not here. */

import type { BlastRadius } from "@kernel/blast-radius.ts";

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
export interface CoverageCollectorPort {
  collect(specDir: string, namespace: string, changedFiles?: string[]): Promise<CoverageReport>;
  /* One report over the dumps of several namespaces, as a collection of them all would be; absent for a collector that reads reports a run writes whole. */
  recollect?(specDir: string, sources: readonly DumpSource[], changedFiles?: string[]): Promise<CoverageReport>;
}
export interface ValueOracleResult {
  valueScore: number | null;
  /* null when the oracle ran but produced no mutation/fault-injection count (e.g. it is wired off) —
   * distinct from a genuine measured zero. Never fabricated as 0. */
  mutantCount: number | null;
  killedCount: number | null;
  details: string;
}
/* A mutant of the served script to re-run, with the spec files whose tests reached it. */
export interface MutantRun { site: MutationSite; specFiles: string[]; }
/* What the mutants did: how many reached a page and were judged, how many a test noticed, and where the others are. */
export interface BundleMutationResult { applied: number; killed: number; survived: { file: string; line: number; operator: string }[]; }
/** Signal-only, never a gate: re-runs the tests that reached each mutant of the changed code in the served script. Null when no mutant reached a page and was judged — never a fabricated zero. */
export interface BundleMutationPort {
  measure(mutants: MutantRun[], specDir: string, namespace: string, baselineCases: string[]): Promise<BundleMutationResult | null>;
}
/** Signal-only: a null valueScore never gates publish. Mutation (code) vs fault-injection (e2e). */
export interface ValueOraclePort {
  measure(br: BlastRadius, repoDir: string, namespace: string, baselineCases?: string[]): Promise<ValueOracleResult>;
}
