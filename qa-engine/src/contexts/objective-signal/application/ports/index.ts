/* Coverage and value-oracle ports. The keystone — unknown NEVER blocks — lives in DecideCoverageService, not here. */

import type { BlastRadius } from "@kernel/blast-radius.ts";

export interface CoveredLines { file: string; lines: number[]; }
/* What a browser coverage collection saw of the scripts a page ran: how many, and how many carried a source map that translates them back to the repository's files. Absent for a collector that reads native reports. */
export interface CoverageScripts { total: number; withSourceMap: number; }
export type BranchKind = "if" | "conditional" | "logical" | "switch";
export interface BranchArm { label: string; taken: boolean; }
/* One decision of a changed file the executed code holds: where its condition is (1-based line, 0-based column), its kind, and whether each arm ran in at least one test. */
export interface BranchHit { file: string; line: number; column: number; kind: BranchKind; arms: BranchArm[]; }
/* `branches` is absent when the collector does not see decisions, or could not read them within its bounds. */
export interface CoverageReport { covered: CoveredLines[]; scripts?: CoverageScripts; branches?: BranchHit[]; }
export interface CoverageCollectorPort {
  collect(specDir: string, namespace: string, changedFiles?: string[]): Promise<CoverageReport>;
}
export interface ValueOracleResult {
  valueScore: number | null;
  /* null when the oracle ran but produced no mutation/fault-injection count (e.g. it is wired off) —
   * distinct from a genuine measured zero. Never fabricated as 0. */
  mutantCount: number | null;
  killedCount: number | null;
  details: string;
}
/** Signal-only: a null valueScore never gates publish. Mutation (code) vs fault-injection (e2e). */
export interface ValueOraclePort {
  measure(br: BlastRadius, repoDir: string, namespace: string, baselineCases?: string[]): Promise<ValueOracleResult>;
}
