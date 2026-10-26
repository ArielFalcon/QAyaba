/*
 * Whether the response oracle's score can be trusted for one campaign case, from its replicates: the kill rate of each use case
 * must hold still from run to run, few of the corrupted run's failures may be the flow breaking (which a corruption of the
 * data cannot be told from), and enough of the baseline suite must be exposed to a corrupted response of an operation in
 * reach. A verdict, never a gate: it says whether the signal may be read, and an app moves toward enforce only once it passes
 * (the enforce gate itself is the measured change-coverage). Pure.
 */
import type { CandidateValue, ValueStats } from "./fault-injection-score.ts";

/* The fewest replicates of one case a verdict is given for. */
export const MIN_REPLICATES = 3;
/* The widest gap between the highest and the lowest kill rate of a use case across replicates. */
export const MAX_REPLICATE_SPREAD = 0.25;
/* The largest share of the corrupted run's failures that may be discarded as the flow breaking. */
export const MAX_FLOW_BREAK_SHARE = 0.2;
/* The smallest share of the baseline-passing specs that must be exposed to a corrupted response of an operation in reach. */
export const MIN_APPLICABLE_SHARE = 0.5;

/* What one replicate's run recorded. A replicate whose re-run measured nothing has no stats. */
export interface CalibrationReplicate {
  perCandidate: readonly CandidateValue[];
  stats: ValueStats | undefined;
}

export interface CandidateCalibration {
  candidateId: string;
  /* Replicates in which the use case had a ratio. */
  scored: number;
  /* The highest minus the lowest kill rate; null with fewer than two scored replicates. */
  spread: number | null;
}

export type CalibrationVerdict = "calibrated" | "not-calibrated" | "insufficient";

export interface Calibration {
  verdict: CalibrationVerdict;
  /* Replicates whose re-run measured something. */
  replicates: number;
  candidates: CandidateCalibration[];
  /* The widest spread of any use case; null when none was scored in two replicates. */
  spread: number | null;
  /* Flow breaks over failures under corruption; 0 when nothing failed. Null with no replicate. */
  flowBreakShare: number | null;
  /* Exposed over baseline-passing specs executed. Null with no replicate. */
  applicableShare: number | null;
  reasons: string[];
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;

export function calibrate(replicates: readonly CalibrationReplicate[]): Calibration {
  const measured = replicates.filter((r): r is CalibrationReplicate & { stats: ValueStats } => r.stats !== undefined);
  const byId = new Map<string, number[]>();
  for (const r of measured) for (const c of r.perCandidate) if (c.ratio !== null) byId.set(c.candidateId, [...(byId.get(c.candidateId) ?? []), c.ratio]);
  const candidates = [...byId].map(([candidateId, ratios]): CandidateCalibration => ({ candidateId, scored: ratios.length, spread: ratios.length >= 2 ? Math.max(...ratios) - Math.min(...ratios) : null }));
  const spreads = candidates.flatMap((c) => (c.spread === null ? [] : [c.spread]));
  const spread = spreads.length > 0 ? Math.max(...spreads) : null;
  const sum = (pick: (s: ValueStats) => number): number => measured.reduce((total, r) => total + pick(r.stats), 0);
  const failed = sum((s) => s.failed);
  const baseline = sum((s) => s.baseline);
  const flowBreakShare = measured.length === 0 ? null : failed === 0 ? 0 : sum((s) => s.flowBreaks) / failed;
  const applicableShare = measured.length === 0 || baseline === 0 ? null : sum((s) => s.exposed) / baseline;
  const reasons: string[] = [];
  if (measured.length < MIN_REPLICATES) {
    return { verdict: "insufficient", replicates: measured.length, candidates, spread, flowBreakShare, applicableShare, reasons: [`${measured.length} replicate(s) measured; at least ${MIN_REPLICATES} are needed`] };
  }
  if (spread === null) reasons.push("no use case was scored in two replicates, so its kill rate cannot be seen to hold still");
  else if (spread > MAX_REPLICATE_SPREAD) reasons.push(`the kill rate of a use case moves by ${pct(spread)} across replicates (at most ${pct(MAX_REPLICATE_SPREAD)})`);
  if (flowBreakShare !== null && flowBreakShare > MAX_FLOW_BREAK_SHARE) reasons.push(`${pct(flowBreakShare)} of the failures under corruption were the flow breaking (at most ${pct(MAX_FLOW_BREAK_SHARE)})`);
  if (applicableShare === null) reasons.push("no baseline-passing spec was executed by the corrupted re-run");
  else if (applicableShare < MIN_APPLICABLE_SHARE) reasons.push(`${pct(applicableShare)} of the baseline specs were exposed to a corrupted response of an operation in reach (at least ${pct(MIN_APPLICABLE_SHARE)})`);
  return { verdict: reasons.length === 0 ? "calibrated" : "not-calibrated", replicates: measured.length, candidates, spread, flowBreakShare, applicableShare, reasons };
}
