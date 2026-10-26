export interface CoveredLines { file: string; lines: number[]; }

/* What a browser coverage collection saw of the scripts a page ran: how many, and how many carried a source map that translates them back to the repository's files. Absent for a collector that reads native reports. */
export interface CoverageScripts { total: number; withSourceMap: number; }

export interface CoverageReport { covered: CoveredLines[]; scripts?: CoverageScripts; }

export interface ValueOracleResult {
  valueScore: number | null;
  /* null when the oracle ran but produced no mutation/fault-injection count (e.g. it is wired off) —
   * distinct from a genuine measured zero. Never fabricated as 0. */
  mutantCount: number | null;
  killedCount: number | null;
  details: string;
}
