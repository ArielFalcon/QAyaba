/*
 * A use case the change makes testable: an entry point its changed symbols reach, with how directly, the evidence path, whether
 * a browser can reach it, and the specs the suite already holds for it. Derived deterministically from the change's scope.
 */
import { entryKey, type ChangedSymbol, type EntryPoint, type ReachBasis, type ReachTier } from "./change-reach.ts";

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

/* The pages through which a browser reaches the candidate: its own route for a page, the pages that reach it for an operation. */
export function candidatePagesOf(candidate: UseCaseCandidate): string[] {
  if (candidate.entry.kind === "page") return [candidate.entry.route];
  return candidate.reachability === "via-page" ? [...candidate.pages] : [];
}

const MAX_LINE_EVIDENCE_CHARS = 240;
const MAX_LINE_SPECS = 3;

/* One line that names a candidate to the lead: id, entry, how directly the change reaches it, the evidence path and the specs the suite already holds for it. Unsanitized: the caller redacts. */
export function candidateLine(candidate: UseCaseCandidate): string {
  const evidence = candidate.evidence.join(" > ");
  const cut = evidence.length > MAX_LINE_EVIDENCE_CHARS ? `${evidence.slice(0, MAX_LINE_EVIDENCE_CHARS)}...` : evidence;
  const specs = candidate.existingSpecs.slice(0, MAX_LINE_SPECS).join(", ");
  return [candidate.id, entryKey(candidate.entry), `${candidate.tier}, ${candidate.reachability}`, cut, specs !== "" ? `specs: ${specs}` : "no spec yet"].filter((part) => part !== "").join(" | ");
}
