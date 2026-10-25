/* Structural equivalence for RunOutcome: two outcomes are behaviorally equivalent when
   their decision-bearing fields match. Per-invocation fields (runId, at) and free-text reasoning
   (reviewerRationale) are NOT behavioral and are excluded.
 */

export interface ComparableOutcome {
  runId: string;
  app: string;
  sha: string;
  mode: string;
  target: string;
  verdict: string;
  errorClass: string | null;
  gateSignals: {
    static: boolean;
    coverageRatio: number | null;
    valueScore: number | null;
    reviewerCorrections: string[];
    reviewerApproved?: boolean;
    reviewerRationale?: string;
    flaky: boolean;
    retries: number;
    /* absent from every committed golden (they predate this instrumentation), so both sides
       default to 0 via the ?? 0 normalization below — the semantic "gate did not fire" value,
       not a spurious null-vs-number mismatch on stale fixtures.
     */
    catalogGateInWindow?: number;
    catalogGateAdvisory?: number;
    catalogGateFailClosed?: number;
  };
  at: string;
}

function behavioralProjection(o: ComparableOutcome): Record<string, unknown> {
  return {
    app: o.app,
    sha: o.sha,
    mode: o.mode,
    target: o.target,
    verdict: o.verdict,
    errorClass: o.errorClass,
    static: o.gateSignals.static,
    coverageRatio: o.gateSignals.coverageRatio,
    valueScore: o.gateSignals.valueScore,
    reviewerCorrections: o.gateSignals.reviewerCorrections,
    reviewerApproved: o.gateSignals.reviewerApproved ?? null,
    flaky: o.gateSignals.flaky,
    retries: o.gateSignals.retries,
    catalogGateInWindow: o.gateSignals.catalogGateInWindow ?? 0,
    catalogGateAdvisory: o.gateSignals.catalogGateAdvisory ?? 0,
    catalogGateFailClosed: o.gateSignals.catalogGateFailClosed ?? 0,
  };
}

export function runOutcomeEquivalent(
  a: ComparableOutcome,
  b: ComparableOutcome,
): { equal: boolean; diff?: string } {
  const pa = behavioralProjection(a);
  const pb = behavioralProjection(b);
  for (const key of Object.keys(pa)) {
    const va = JSON.stringify(pa[key]);
    const vb = JSON.stringify(pb[key]);
    if (va !== vb) return { equal: false, diff: `${key}: ${va} !== ${vb}` };
  }
  return { equal: true };
}
