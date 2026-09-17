/* Live points where a coordination decision may govern execution. pre-generate and fix-loop-regen are independent (never implied by each other). Coordination is always on — there is no advisory downgrade. */
import type { AgentCapability } from "./agent-capability.ts";
import type { ProposedOrchestrationDecision } from "./proposed-orchestration-decision.ts";

export const COORDINATION_ACTIVE_POINTS = ["pre-generate", "fix-loop-regen"] as const;
export type CoordinationActivePoint = (typeof COORDINATION_ACTIVE_POINTS)[number];

export function shouldHonorActiveDelegation(input: {
  proposal: ProposedOrchestrationDecision | undefined;
  enabledPoints: readonly CoordinationActivePoint[];
  point: CoordinationActivePoint;
  sidekickAvailable: boolean;
}): boolean {
  if (!input.proposal) return false;
  if (input.proposal.decision.action !== "delegate") return false;
  if (!input.enabledPoints.includes(input.point)) return false;
  if (!input.sidekickAvailable) return false;
  return true;
}

/** FixLoop regen may use a sidekick only when the point is enabled + capability is sidekick-*. */
export function shouldHonorFixLoopSidekick(input: {
  enabledPoints: readonly CoordinationActivePoint[];
  capability: AgentCapability;
  sidekickAvailable: boolean;
}): boolean {
  if (!input.enabledPoints.includes("fix-loop-regen")) return false;
  if (!input.capability.startsWith("sidekick")) return false;
  if (!input.sidekickAvailable) return false;
  return true;
}
