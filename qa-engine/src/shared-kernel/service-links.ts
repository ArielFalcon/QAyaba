/* The cross-repo link vocabulary service-topology resolves and the generation and run flow consume. */

/** Cross-repo symbol reference. Not the same as LocalSymbolRef (intra-repo). */
export interface ServiceSymbolRef {
  repo: string;
  file: string;
  symbol: string;
}

/** A resolved cross-repo dependency link. Transport is open-union; the domain treats it as opaque. */
export interface ServiceLink {
  from: ServiceSymbolRef;
  to: ServiceSymbolRef;
  transport: "http" | "event" | "rpc";
  contractRef?: string;
  /** The contract operation an HTTP link calls: its verb (upper case) and its path as the contract declares it. */
  operation?: { verb: string; path: string };
  confidence: number;
  source: string;
}

/** A detected FE↔BE contract drift: the frontend calls an endpoint the backend contract does not declare. */
export interface ContractDrift {
  from: ServiceSymbolRef;
  verb: string;
  path: string;
}

export const MATCH_TIER = {
  CONTRACT_FILE: "contract-file",
  IMPACTED_SYMBOL: "impacted-symbol",
} as const;
export type MatchTier = (typeof MATCH_TIER)[keyof typeof MATCH_TIER];

/** tier is a closed, code-defined literal — never a sanitizer-sentinel string and never attacker/agent-controlled. */
export interface ImpactedLink {
  link: ServiceLink;
  tier: MatchTier;
  /* How the link's operation changed in the contract file, when the file's two versions could be compared. */
  operationChange?: "added" | "removed" | "changed";
  /* `contract-file`: the contract file changed and its two versions could not be compared, so the link is impacted on the file alone. */
  basis?: "contract-file";
}

export interface CrossRepoImpact {
  impactedLinks: ImpactedLink[];
  serviceImpacted?: ServiceSymbolRef[];
}
