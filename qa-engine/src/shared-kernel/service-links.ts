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

/**
 * What makes two links one: both ends (repo, file, symbol), the transport, the contract operation they name and the operation
 * the call makes. A call site that calls two operations of one service, or one operation of two, holds two links. The one
 * definition every de-duplication of links uses; a key that left out a part would drop a distinct link.
 */
export function linkIdentity(link: ServiceLink): string {
  const { from, to, transport, contractRef, operation } = link;
  return JSON.stringify([from.repo, from.file, from.symbol, to.repo, to.file, to.symbol, transport, contractRef ?? null, operation?.verb ?? null, operation?.path ?? null]);
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

/** Which way a link was reached from the change: `upstream`, a repo that depends on what changed; `downstream`, a repo the changed code depends on. */
export type ImpactDirection = "upstream" | "downstream";

/** How a link beyond the first hop was reached: the direction, and the links crossed from the changed repo to its call site, nearest the change first. */
export interface ImpactReach {
  direction: ImpactDirection;
  via: ServiceLink[];
}

/** A hop the walk could not finish: the repo it stopped at and why. What lies beyond it is neither claimed nor ruled out. */
export interface ImpactStop {
  repo: string;
  direction: ImpactDirection;
  reason: string;
}

/** tier is a closed, code-defined literal — never a sanitizer-sentinel string and never attacker/agent-controlled. */
export interface ImpactedLink {
  link: ServiceLink;
  tier: MatchTier;
  /* How the link's operation changed in the contract file, when the file's two versions could be compared. */
  operationChange?: "added" | "removed" | "changed";
  /* `contract-file`: the contract file changed and its two versions could not be compared, so the link is impacted on the file alone. */
  basis?: "contract-file";
  /* Absent: reached in one hop, upstream. */
  reach?: ImpactReach;
}

export interface CrossRepoImpact {
  impactedLinks: ImpactedLink[];
  stops?: ImpactStop[];
}
