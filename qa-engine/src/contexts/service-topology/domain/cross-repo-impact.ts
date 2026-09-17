import type { ServiceLink, ServiceSymbolRef } from "./index.ts";

export const MATCH_TIER = {
  CONTRACT_FILE: "contract-file",
  IMPACTED_SYMBOL: "impacted-symbol",
} as const;
export type MatchTier = (typeof MATCH_TIER)[keyof typeof MATCH_TIER];

/** tier is a closed, code-defined literal — never a sanitizer-sentinel string and never attacker/agent-controlled. */
export interface ImpactedLink {
  link: ServiceLink;
  tier: MatchTier;
}


export interface CrossRepoImpact {
  impactedLinks: ImpactedLink[];
  serviceImpacted?: ServiceSymbolRef[];
}
