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


/* A path's segments, a parameter (`{id}`, `:id`) reduced to one placeholder. */
function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean).map((s) => (/^\{.*\}$/.test(s) || s.startsWith(":") ? "{}" : s));
}

/**
 * Whether a handler's route serves a contract operation: same verb, and the same path segments, parameters matching any
 * parameter. A prefix the deployment adds on one side only (a gateway or servlet path) is tolerated: one path may end with
 * the other, as long as the shorter one names at least one literal segment, so a bare `/{id}` never matches everything.
 */
export function routeServesOperation(route: { method: string; path: string }, operation: { verb: string; path: string }): boolean {
  if (route.method.toUpperCase() !== operation.verb.toUpperCase()) return false;
  const a = pathSegments(route.path);
  const b = pathSegments(operation.path);
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length === 0 || !shorter.some((s) => s !== "{}")) return false;
  const tail = longer.slice(longer.length - shorter.length);
  return shorter.every((s, i) => s === tail[i]);
}

export interface CrossRepoImpact {
  impactedLinks: ImpactedLink[];
  serviceImpacted?: ServiceSymbolRef[];
}
