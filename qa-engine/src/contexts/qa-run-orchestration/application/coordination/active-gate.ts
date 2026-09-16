// Fase 13 — which coordination decisions may govern a live pipeline point.
// Shadow/off never honor. Active only honors points explicitly enabled.
import type { ProposedOrchestrationDecision } from "./proposed-orchestration-decision.ts";

export const COORDINATION_ACTIVE_POINTS = ["pre-generate"] as const;
export type CoordinationActivePoint = (typeof COORDINATION_ACTIVE_POINTS)[number];

export function shouldHonorActiveDelegation(input: {
  proposal: ProposedOrchestrationDecision | undefined;
  enabledPoints: readonly CoordinationActivePoint[];
  point: CoordinationActivePoint;
  sidekickAvailable: boolean;
}): boolean {
  if (!input.proposal) return false;
  if (input.proposal.advisoryOnly) return false;
  if (input.proposal.decision.action !== "delegate") return false;
  if (!input.enabledPoints.includes(input.point)) return false;
  if (!input.sidekickAvailable) return false;
  return true;
}
