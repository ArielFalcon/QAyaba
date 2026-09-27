/* Coverage and value-oracle ports. The keystone — unknown NEVER blocks — lives in DecideCoverageService, not here. */

import type { BlastRadius } from "@kernel/blast-radius.ts";

export interface CoveredLines { file: string; lines: number[]; }
export interface CoverageReport { covered: CoveredLines[]; }
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
