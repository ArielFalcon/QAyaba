/* Pre-execution grounding gate. Two sub-gates share one captured route set: (1) ambiguity — MULTIPLE-node contradictions paired per spec to that spec's own routes; feeds one-shot repair and, on a persisting re-check, the deterministic block. (2) catalog — a test-id absent from a captured-and-settled route inside the confident window feeds only one-shot repair, never the deterministic block. Pure: no browser, no I/O. */

import {
  unscopedMultipleContradictions,
  confidentWindowEnd,
  extractTestIdSelectorsWithIndex,
  firstGotoRoute,
} from "./helpers/selector-check.ts";

/* Domain-local mirror of generation/infrastructure's RouteSnapshot ∩ RouteCatalog — only the fields this service reads. `nodes` mirrors RouteSnapshot.nodes (the "role: name" a11y tree, used by the ambiguity check). `status`/`settled`/`testIds` mirror RouteCatalog (the Pillar-2 catalog gate's own confidence fields) — all optional, defaulting to the SAME conservative posture buildRouteCatalog applies to a degraded/uncaptured route: status "degraded" (untrusted), settled false, testIds empty — so a caller that only ever captures `nodes` (ambiguity-only, no catalog work) never needs to fabricate catalog fields, and the gate correctly stays advisory-only for it. */
export interface RouteTree {
  route: string;
  nodes: string[];
  status?: "captured" | "degraded";
  settled?: boolean;
  testIds?: Map<string, number>;
}

export interface PreExecGroundingInput {
  specSources: string[];
  routes: RouteTree[];
}

export interface PreExecGroundingResult {
  corrections: string[];
  preExecAmbiguityCatches: number;
  catalogGateInWindow: number;
  catalogGateAdvisory: number;
  catalogGateFailClosed: number;
}

function routesForSpec(specSrc: string, routes: readonly RouteTree[]): RouteTree[] {
  const targeted = extractGotoRoutes(specSrc);
  if (targeted.size === 0) return [...routes]; /* un-pairable → advisory-safe fallback: check everything */
  const paired = routes.filter((r) => targeted.has(r.route));
  /* A spec named routes that were never captured (e.g. capture failed/degraded and was dropped upstream) — fall back to the full set rather than silently grounding against nothing, same fail-safe posture as the "no literal goto" branch above. */
  return paired.length > 0 ? paired : [...routes];
}

/* Every literal route a spec's `.goto(...)` calls name, normalized with a leading slash — the per-spec pairing key. A sibling of firstGotoRoute (selector-check.ts), widened from "first only" to "every literal goto" because a spec's flow can legitimately visit more than one route and each is real ground truth for ITS OWN ambiguity check (unlike the single-route catalog-gate confident window, which is deliberately first-goto-only — see firstGotoRoute's own header). Un-navigable routes (interpolated `${…}` or an absolute URL) are skipped, same as firstGotoRoute. */
function extractGotoRoutes(specSrc: string): Set<string> {
  const out = new Set<string>();
  const re = /\.goto\(\s*["'`]([^"'`]+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(specSrc)) !== null) {
    const raw = m[1]!.trim();
    if (!raw || raw.includes("${") || /^https?:\/\//i.test(raw)) continue;
    out.add(raw.startsWith("/") ? raw : `/${raw}`);
  }
  return out;
}

function ambiguityContradictions(specSources: readonly string[], routes: readonly RouteTree[]): string[] {
  const all: string[] = [];
  for (const specSrc of specSources) {
    const paired = routesForSpec(specSrc, routes);
    const trees = paired.map((r) => r.nodes).filter((n) => n.length > 0);
    all.push(...unscopedMultipleContradictions([specSrc], trees, "pre-write"));
  }
  return [...new Set(all)];
}

function catalogCorrections(
  specSources: readonly string[],
  routes: readonly RouteTree[],
): { corrections: string[]; inWindow: number; advisory: number } {
  if (!specSources.some((s) => extractTestIdSelectorsWithIndex(s).length > 0)) {
    return { corrections: [], inWindow: 0, advisory: 0 };
  }
  const byRoute = new Map(routes.map((r) => [r.route, r]));
  const corrections: string[] = [];
  let inWindow = 0;
  let advisory = 0;
  for (const specSrc of specSources) {
    const firstRoute = firstGotoRoute(specSrc); /* the FIRST LITERAL goto — consistent with confidentWindowEnd */
    if (firstRoute === undefined) continue; /* un-navigable / no first goto → no window route → advisory */
    const windowRoute = byRoute.get(firstRoute);
    if (windowRoute === undefined) continue; /* route not captured → advisory */
    /* Fail-closed path may trust only a captured && settled route — degraded/unsettled stays advisory. */
    const trusted = (windowRoute.status ?? "degraded") === "captured" && windowRoute.settled === true;
    const windowEnd = confidentWindowEnd(specSrc);
    const testIds = windowRoute.testIds ?? new Map<string, number>();
    for (const { value, index } of extractTestIdSelectorsWithIndex(specSrc)) {
      if (trusted && index < windowEnd) {
        inWindow++;
        if (!testIds.has(value)) {
          corrections.push(
            `getByTestId('${value}') is NOT in the captured DOM of route '${firstRoute}' — this test-id does not exist on the page. Use only a test-id present in the grounded DOM snapshot, or a role/label selector; never invent a test-id.`,
          );
        }
      } else {
        advisory++;
      }
    }
  }
  return { corrections, inWindow, advisory };
}

/* One-shot pre-execution grounding: combined ambiguity + catalog corrections for one corrective regen. This function never blocks — the caller captures routes, feeds corrections into one regen, and re-invokes (or just the ambiguity half) to decide whether a persisting ambiguity should escalate. */
export function checkPreExecGrounding(input: PreExecGroundingInput): PreExecGroundingResult {
  const { specSources, routes } = input;
  const ambiguities = ambiguityContradictions(specSources, routes);
  const catalog = catalogCorrections(specSources, routes);
  return {
    corrections: [...ambiguities, ...catalog.corrections],
    preExecAmbiguityCatches: ambiguities.length,
    catalogGateInWindow: catalog.inWindow,
    catalogGateAdvisory: catalog.advisory,
    catalogGateFailClosed: catalog.corrections.length,
  };
}

export function checkPersistingAmbiguity(input: PreExecGroundingInput): string[] {
  return ambiguityContradictions(input.specSources, input.routes);
}
