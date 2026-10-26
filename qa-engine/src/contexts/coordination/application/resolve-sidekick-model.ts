/* Infra resolves escalated capacity to an optional model id; domain never names providers. */
import { SIDEKICK_TIER, type SidekickTier } from "./sidekick-kinds.ts";

export function resolveSidekickModel(
  tier: SidekickTier,
  escalatedModel: string | undefined,
): string | undefined {
  if (tier !== SIDEKICK_TIER.ESCALATED) return undefined;
  const trimmed = escalatedModel?.trim();
  return trimmed || undefined;
}
