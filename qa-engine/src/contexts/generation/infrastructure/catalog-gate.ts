/* Bounded safety net: a selector absent from the captured DOM is caught before execution, but only inside the confident window where the catalog is trustworthy. Pure — no browser, no I/O. */

import { confidentWindowEnd, extractTestIdSelectorsWithIndex } from "./selector-catalog-window.ts";
import type { RouteCatalog } from "./route-catalog.ts";

export interface CatalogGateResult {
  /** Groundable selectors ABSENT from the catalog inside the confident window on a captured&&settled route → fabricated. The pipeline regenerates once (no 30s timeout). */
  failClosed: string[];
  /** Groundable selectors that fell inside the confident window — the fail-closed denominator for the design's "honest coverage" fraction: inWindow / (inWindow + advisory). */
  inWindow: number;
  /** Selectors the gate could NOT confidently verify (post-navigation, or an untrusted catalog). Left to the runtime backstop, never blocked. */
  advisory: number;
}

/** Gate a spec's test-id selectors against the catalog of its INITIAL route (windowRoute). A selector is fail-closed ONLY when it is (a) inside the confident window — lexically before the first click/tap or the second goto, where the initial-route catalog is still the live DOM — AND (b) on a captured&&settled route, the only place absence is conclusive. Every other selector is counted advisory and never blocked: the gate can weaken a proxy but must never turn a valid spec invalid (safe direction). */
export function catalogGate(specSrc: string, windowRoute: RouteCatalog): CatalogGateResult {
  const trusted = windowRoute.status === "captured" && windowRoute.settled;
  const windowEnd = confidentWindowEnd(specSrc);
  const failClosed: string[] = [];
  let inWindow = 0;
  let advisory = 0;
  for (const { value, index } of extractTestIdSelectorsWithIndex(specSrc)) {
    if (trusted && index < windowEnd) {
      inWindow++;
      if (!windowRoute.testIds.has(value)) failClosed.push(value);
    } else {
      advisory++;
    }
  }
  return { failClosed, inWindow, advisory };
}
