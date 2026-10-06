/* Scorecard types for the shell learning store (history + control-plane views). */
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

export function updateScorecard(prev: Scorecard | null, entry: ScorecardEntry): Scorecard {
  const entries = [...(prev?.entries ?? []), entry];
  const measured = entries.filter((e) => e.valueScore !== null);
  const lastMeasured = measured[measured.length - 1] ?? null;

  return {
    app: entry.app,
    updatedAt: new Date().toISOString(),
    entries,
    summary: {
      totalRuns: entries.length,
      measuredRuns: measured.length,
      avgValueScore: measured.length > 0
        ? measured.reduce((s, e) => s + (e.valueScore ?? 0), 0) / measured.length
        : null,
      lastValueScore: lastMeasured?.valueScore ?? null,
    },
  };
}
