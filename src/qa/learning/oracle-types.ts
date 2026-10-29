/* Scorecard types for the shell learning store (history + control-plane views). Nothing writes a scorecard any more; the signals view still reads the rows runs left behind. */
import type { TestTarget } from "../../types";

export interface ScorecardEntry {
  runId: string;
  app: string;
  sha: string;
  target: TestTarget;
  valueScore: number | null;
  /* null means "not measured" (the value-oracle never ran or reported no count) — distinct from a
   * genuine measured zero. Never a fabricated 0. */
  mutantCount: number | null;
  killedCount: number | null;
  at: string;
}

export interface Scorecard {
  app: string;
  updatedAt: string;
  entries: ScorecardEntry[];
  summary: {
    totalRuns: number;
    measuredRuns: number;
    avgValueScore: number | null;
    lastValueScore: number | null;
  };
}
