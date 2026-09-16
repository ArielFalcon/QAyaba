// Escalation ladder (Fase 9). Capability steps only — human abort is terminal, not a capability.
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
