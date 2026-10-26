/* Use-case candidates for tests: a page candidate the change reaches, with the evidence path a brief shows. */
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";

export function pageCandidate(route: string, evidence: string[] = [`page ${route}`], over: Partial<UseCaseCandidate> = {}): UseCaseCandidate {
  return { id: `uc-${route}`, entry: { kind: "page", repo: "org/web", route }, tier: "direct", basis: "implementation", evidence, seeds: [], confidence: 1, reachability: "page", pages: [], existingSpecs: [], ...over };
}

export const pageCandidates = (routes: readonly string[]): UseCaseCandidate[] => routes.map((route) => pageCandidate(route));
