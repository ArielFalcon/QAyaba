// Fase 13 — which coordination decisions may govern a live pipeline point.
// Shadow/off never honor. Active only honors points explicitly enabled.
// pre-generate and fix-loop-regen are independent points (never implied by each other).
import type { AgentCapability } from "./agent-capability.ts";
import type { CoordinationMode } from "./coordination-mode.ts";
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
  if (input.proposal.advisoryOnly) return false;
  if (input.proposal.decision.action !== "delegate") return false;
  if (!input.enabledPoints.includes(input.point)) return false;
  if (!input.sidekickAvailable) return false;
  return true;
}

/** FixLoop regen may use a sidekick only when active + point enabled + capability is sidekick-*. */
export function shouldHonorFixLoopSidekick(input: {
  coordinationMode: CoordinationMode;
  enabledPoints: readonly CoordinationActivePoint[];
  capability: AgentCapability;
  sidekickAvailable: boolean;
}): boolean {
  if (input.coordinationMode !== "active") return false;
  if (!input.enabledPoints.includes("fix-loop-regen")) return false;
  if (!input.capability.startsWith("sidekick")) return false;
  if (!input.sidekickAvailable) return false;
  return true;
}
