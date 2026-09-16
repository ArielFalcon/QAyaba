// Proposed assignment from the coordinator. In shadow/off modes the pipeline ignores it for
// generation/publish; active mode may honor only the points that have been explicitly enabled.
import type { CoordinationDecision } from "./coordination-decision.ts";
import type { CoordinationMode } from "./coordination-mode.ts";

export interface ProposedOrchestrationDecision {
  readonly mode: CoordinationMode;
  readonly decision: CoordinationDecision;
  readonly recordedAt: number;
  /** When true, RunQaUseCase must NOT let this decision change generation/publish. */
  readonly advisoryOnly: boolean;
}

export function proposeFromDecision(
  mode: CoordinationMode,
  decision: CoordinationDecision,
  nowMs = Date.now(),
): ProposedOrchestrationDecision {
  return {
    mode,
    decision,
    recordedAt: nowMs,
    advisoryOnly: mode !== "active",
  };
}
