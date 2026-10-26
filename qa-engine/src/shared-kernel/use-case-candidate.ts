/*
 * A use case the change makes testable: an entry point its changed symbols reach, with how directly, the evidence path, whether
 * a browser can reach it, and the specs the suite already holds for it. Derived deterministically from the change's scope.
 */
import type { ChangedSymbol, EntryPoint, ReachBasis, ReachTier } from "./change-reach.ts";

/* `page` is a page of the app; `via-page` an operation that some page reaches in the browser (`pages` names them); `backend-only` an operation no page reaches. */
export type Reachability = "page" | "via-page" | "backend-only";

export interface UseCaseCandidate {
  /* `uc-` and 8 hex digits, stable for the same entry point whatever the order the candidates were derived in. */
  id: string;
  entry: EntryPoint;
  tier: ReachTier;
  basis: ReachBasis;
  evidence: string[];
  seeds: ChangedSymbol[];
  confidence: number;
  reachability: Reachability;
  pages: string[];
  existingSpecs: string[];
  /* The map's name for the page, when it has one. */
  label?: string;
}

/* The routes of the candidates that are pages, in the order given. */
export function pageRoutesOf(candidates: readonly UseCaseCandidate[]): string[] {
  return candidates.flatMap((c) => (c.entry.kind === "page" ? [c.entry.route] : []));
}
