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

/* The verbs a route node can carry for "any method" (a mapping with no method, a catch-all registration). */
const ANY_VERB = new Set(["ANY", "ALL", "*"]);

/**
 * Whether a handler's route serves a contract operation: same verb (a handler that takes any verb serves every one), and the
 * same path segments, parameters matching any parameter. A base path the deployment adds on one side only (a gateway or servlet
 * path) is tolerated: one path may end with the other when the segments before it are all literals and the shorter one names at
 * least one literal segment. A parameter in the extra segments means a different resource (`GET /items` is not
 * `/orders/{id}/items`), and a bare `/{id}` never matches everything.
 */
export function routeServesOperation(route: { method: string; path: string }, operation: { verb: string; path: string }): boolean {
  const verb = route.method.toUpperCase();
  if (!ANY_VERB.has(verb) && verb !== operation.verb.toUpperCase()) return false;
  const a = pathSegments(route.path);
  const b = pathSegments(operation.path);
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length === 0 || !shorter.some((s) => s !== "{}")) return false;
  const cut = longer.length - shorter.length;
  if (longer.slice(0, cut).includes("{}")) return false;
  const tail = longer.slice(cut);
  return shorter.every((s, i) => s === tail[i]);
}

export interface CrossRepoImpact {
  impactedLinks: ImpactedLink[];
  serviceImpacted?: ServiceSymbolRef[];
}
