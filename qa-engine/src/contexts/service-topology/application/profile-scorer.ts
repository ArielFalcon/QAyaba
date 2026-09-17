import { buildServiceBoundaryResolver } from "../infrastructure/resolver-factory.ts";
import type { BoundaryProfile, RepoRef } from "../domain/index.ts";

/** How much of a candidate BoundaryProfile's extracted call-site pattern actually resolves. */
export interface ProfileScore {
  links: number;
  drift: number;
  external: number;
  unresolved: number;
  /** Total call-sites the pattern extracted, across all four result buckets. */
  coverage: number;
  /** links / coverage, or 0 when coverage === 0 (never NaN). */
  resolutionRatio: number;
  /** links resolutionRatio — resolved-volume weighted by precision. The primary ranking key: raw links reward over-extraction. */
  resolvedScore: number;
}

const ZERO_SCORE: ProfileScore = Object.freeze({
  links: 0,
  drift: 0,
  external: 0,
  unresolved: 0,
  coverage: 0,
  resolutionRatio: 0,
  resolvedScore: 0,
});

/** Score one candidate profile over the app's mirrors. Fail-open: an unresolvable app degrades to ZERO_SCORE, never a throw. */
export async function scoreProfile(
  profile: BoundaryProfile,
  system: RepoRef[],
  front: RepoRef,
): Promise<ProfileScore> {
  const resolver = buildServiceBoundaryResolver([profile]);
  const result = await resolver.resolveLinks(system, front);

  const links = result.links.length;
  const drift = result.drift.length;
  const external = result.external.length;
  const unresolved = result.unresolved.length;
  const coverage = links + drift + external + unresolved;

  if (coverage === 0) return ZERO_SCORE;

  const resolutionRatio = links / coverage;
  return { links, drift, external, unresolved, coverage, resolutionRatio, resolvedScore: links * resolutionRatio };
}

/** Pick the best candidate: highest resolvedScore, then resolutionRatio, never an absolute threshold. All-ZERO_SCORE returns the first candidate (deterministic "none resolve"). Empty list → null. */
export function selectBestProfile<T extends { score: ProfileScore }>(candidates: readonly T[]): T | null {
  if (candidates.length === 0) return null;

  let best = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (isBetter(candidate.score, best.score)) best = candidate;
  }
  return best;
}

/** True when a should replace b. Primary key: resolvedScore. Tie-break: resolutionRatio, not links (equal resolvedScore on small integers would otherwise pick the noisier candidate). Non-finite resolvedScore is coerced to -Infinity so no poisoned score wins. A remaining tie is first-wins, never a coverage comparison. */
function isBetter(a: ProfileScore, b: ProfileScore): boolean {
  const aResolved = Number.isFinite(a.resolvedScore) ? a.resolvedScore : -Infinity;
  const bResolved = Number.isFinite(b.resolvedScore) ? b.resolvedScore : -Infinity;
  if (aResolved !== bResolved) return aResolved > bResolved;
  if (a.resolutionRatio !== b.resolutionRatio) return a.resolutionRatio > b.resolutionRatio;
  return false;
}
