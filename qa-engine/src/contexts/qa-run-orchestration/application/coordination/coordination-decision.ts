// Assignment decision for the Fase 1 seam. Distinct from §11 OrchestrationDecision
// (accept / retry-sidekick / continue-fix-loop / …), which belongs to the Fase 7 router.
import type { AgentCapability } from "./agent-capability.ts";
import type { EvidenceRef } from "./evidence-ref.ts";

export const COORDINATION_ACTIONS = [
  "direct",
  "delegate",
  "retry",
  "escalate",
  "takeover",
  "abort",
] as const;
export type CoordinationAction = (typeof COORDINATION_ACTIONS)[number];

export function isCoordinationAction(value: string): value is CoordinationAction {
  return (COORDINATION_ACTIONS as readonly string[]).includes(value);
}

export interface CoordinationDecision {
  readonly action: CoordinationAction;
  readonly reason: string;
  readonly evidence: readonly EvidenceRef[];
  readonly nextCapability?: AgentCapability;
}
