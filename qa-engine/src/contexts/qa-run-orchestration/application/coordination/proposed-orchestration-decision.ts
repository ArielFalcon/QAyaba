// Proposed assignment from the coordinator. RunQaUseCase honors it only at the
// explicitly enabled live points (pre-generate / fix-loop-regen); the pipeline's own
// gates, reviewer and FixLoop always keep final authority.
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
