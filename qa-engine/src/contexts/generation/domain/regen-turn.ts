/* The signals that turn a generation turn into a regeneration: failing cases, reviewer corrections, a coverage gap, or deterministic selector contradictions. */
export interface RegenSignals {
  fixCases?: readonly unknown[];
  reviewCorrections?: readonly unknown[];
  coverageGap?: string;
  selectorContradictions?: readonly unknown[];
}

/* The ONE place that decides whether a turn is a regeneration; every prompt builder asks it instead of re-deriving the answer. */
export function isReGenTurn(signals: RegenSignals): boolean {
  return Boolean(
    signals.fixCases?.length ||
      signals.reviewCorrections?.length ||
      signals.coverageGap ||
      signals.selectorContradictions?.length,
  );
}
