/* FixLoop keeps retries and adjudication; coordination only selects who regenerates. No second retry loop. */
import type { AgentCapability } from "./agent-capability.ts";
import type { OrchestrationDecision } from "./orchestration-router.ts";

export function capabilityForFixLoopRound(input: {
  orchestration: OrchestrationDecision;
  fallback: AgentCapability;
}): AgentCapability {
  if (input.orchestration.nextCapability) return input.orchestration.nextCapability;
  if (input.orchestration.action === "continue-fix-loop") return input.fallback;
  if (input.orchestration.action === "lead-takeover") return "lead";
  if (input.orchestration.action === "escalate-sidekick") return "sidekick-escalated";
  if (input.orchestration.action === "retry-sidekick") {
    return input.orchestration.nextCapability ?? "sidekick-standard";
  }
  return input.fallback;
}
