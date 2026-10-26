/* Infra resolves escalated capacity to an optional model id; domain never names providers. */
import type { AgentCapability } from "./agent-capability.ts";

export function resolveSidekickModel(
  capability: AgentCapability,
  escalatedModel: string | undefined,
): string | undefined {
  if (capability !== "sidekick-escalated") return undefined;
  const trimmed = escalatedModel?.trim();
  return trimmed || undefined;
}
