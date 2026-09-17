/* Capability rungs only — human abort is terminal, not a capability. */
import type { AgentCapability } from "./agent-capability.ts";

export const ESCALATION_LADDER: readonly AgentCapability[] = [
  "sidekick-standard",
  "sidekick-escalated",
  "lead",
] as const;

export function nextEscalation(current: AgentCapability): AgentCapability | "human" {
  if (current === "sidekick-standard") return "sidekick-escalated";
  if (current === "sidekick-escalated") return "lead";
  return "human";
}

export function canRetrySameCapability(input: {
  capability: AgentCapability;
  sameFingerprint: boolean;
  needsLead: boolean;
}): boolean {
  if (input.needsLead) return false;
  if (input.sameFingerprint) return false;
  return true;
}

/** Prefer the higher rung — never demote after escalate / architecture needs-lead. */
export function raiseCapabilityFloor(
  current: AgentCapability,
  floor: AgentCapability | undefined,
): AgentCapability {
  if (!floor) return current;
  const order: readonly AgentCapability[] = ["sidekick-standard", "sidekick-escalated", "lead"];
  const ci = order.indexOf(current);
  const fi = order.indexOf(floor);
  if (ci < 0) return floor;
  if (fi < 0) return current;
  return ci >= fi ? current : floor;
}

/** After needs-lead: advance one rung (human → lead for GenerationPort fail-open). */
export function advanceAfterNeedsLead(current: AgentCapability): AgentCapability {
  const next = nextEscalation(current);
  return next === "human" ? "lead" : next;
}
