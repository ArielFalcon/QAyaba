/* Proposed assignment. RunQaUseCase honors it only at enabled live points (pre-generate / fix-loop-regen); gates, reviewer, and FixLoop keep final authority. */
import type { CoordinationDecision } from "./coordination-decision.ts";

export interface ProposedOrchestrationDecision {
  readonly decision: CoordinationDecision;
  readonly recordedAt: number;
}

export function proposeFromDecision(
  decision: CoordinationDecision,
  nowMs = Date.now(),
): ProposedOrchestrationDecision {
  return {
    decision,
    recordedAt: nowMs,
  };
}
