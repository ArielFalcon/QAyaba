/* Adaptive routing policy. Default is deterministic proposer thresholds — no LLM router. */
export interface AdaptiveRoutingSignals {
  readonly recentEscalateRate: number;
  readonly recentNoProgressRate: number;
  readonly avgDelegationMs: number;
}

export interface AdaptiveRoutingPolicy {
  /** Raise file-count threshold for delegation when escalate rate is high. */
  delegationFileThreshold(signals: AdaptiveRoutingSignals): number;
}

export const DEFAULT_ADAPTIVE_POLICY: AdaptiveRoutingPolicy = {
  delegationFileThreshold(signals) {
    if (signals.recentEscalateRate > 0.4) return 12;
    if (signals.recentNoProgressRate > 0.5) return 10;
    return 8;
  },
};
