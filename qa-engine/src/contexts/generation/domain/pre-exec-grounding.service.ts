/* Pre-execution grounding. Two sub-checks share one captured route set: (1) ambiguity — MULTIPLE-node contradictions paired per spec to that spec's own routes. It is a regex over the spec text, with false positives that real execution does not have (a locator held in a variable, a name given by a constant or a RegExp), so its findings are ADVISORY telemetry: they are counted and told, never a correction, an origin or a block, and execution decides. (2) catalog — a test-id absent from a captured-and-settled route inside the confident window is the only thing that feeds the one-shot repair, and never a block. Pure: no browser, no I/O. */

import {
  unscopedMultipleContradictions,
  confidentWindowEnd,
  extractTestIdSelectorsWithIndex,
  firstGotoRoute,
  type ContradictionOrigin,
} from "./selector-check.ts";

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
  /* What the one-shot repair is asked to fix: the catalog gate's test-ids. Never an ambiguity. */
  corrections: string[];
  /* The spec each correction was raised on, by its index among the input's specSources: a correction two specs raise has an origin for each. Only the specs that raised a correction are origins; one that uses a test-id the page has, or is on another route, is not. */
  origins: ContradictionOrigin[];
  /* The ambiguities the check found, each told once however many specs raise it. Advisory: for the log and the signal, never for the repair, the block or the verdict. */
  ambiguities: string[];
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

/* Each ambiguity is told once, however many specs raise it. */
function ambiguityContradictions(specSources: readonly string[], routes: readonly RouteTree[]): string[] {
  const raised = specSources.flatMap((specSrc) => {
    const trees = routesForSpec(specSrc, routes).map((r) => r.nodes).filter((n) => n.length > 0);
    return unscopedMultipleContradictions([specSrc], trees, "pre-write");
  });
  return [...new Set(raised)];
}

function catalogCorrections(
  specSources: readonly string[],
  routes: readonly RouteTree[],
): { origins: ContradictionOrigin[]; inWindow: number; advisory: number } {
  if (!specSources.some((s) => extractTestIdSelectorsWithIndex(s).length > 0)) {
    /* mutation-scope:begin no-catalog-result */
    return { origins: [], inWindow: 0, advisory: 0 };
    /* mutation-scope:end no-catalog-result */
  }
  const byRoute = new Map(routes.map((r) => [r.route, r]));
  /* mutation-scope:begin origins-accumulators */
  const origins: ContradictionOrigin[] = [];
  /* mutation-scope:end origins-accumulators */
  let inWindow = 0;
  let advisory = 0;
  /* mutation-scope:begin per-spec-first-route */
  for (const [specIndex, specSrc] of specSources.entries()) {
  /* mutation-scope:end per-spec-first-route */
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
          /* mutation-scope:begin contradiction-origin-push */
          origins.push({
            contradiction: `getByTestId('${value}') is NOT in the captured DOM of route '${firstRoute}' — this test-id does not exist on the page. Use only a test-id present in the grounded DOM snapshot, or a role/label selector; never invent a test-id.`,
            specIndex,
          });
          /* mutation-scope:end contradiction-origin-push */
        }
      } else {
        advisory++;
      }
    }
  }
  /* mutation-scope:begin catalog-result */
  return { origins, inWindow, advisory };
  /* mutation-scope:end catalog-result */
}

/* One-shot pre-execution grounding: the catalog corrections for one corrective regen, and the ambiguities as an advisory. This function never blocks — the caller captures routes and feeds the corrections into one regen. */
export function checkPreExecGrounding(input: PreExecGroundingInput): PreExecGroundingResult {
  const { specSources, routes } = input;
  const ambiguities = ambiguityContradictions(specSources, routes);
  const catalog = catalogCorrections(specSources, routes);
  return {
    /* mutation-scope:begin corrections-and-origins */
    corrections: catalog.origins.map((origin) => origin.contradiction),
    origins: catalog.origins,
    /* mutation-scope:end corrections-and-origins */
    ambiguities,
    preExecAmbiguityCatches: ambiguities.length,
    catalogGateInWindow: catalog.inWindow,
    catalogGateAdvisory: catalog.advisory,
    /* mutation-scope:begin fail-closed-count */
    catalogGateFailClosed: catalog.origins.length,
    /* mutation-scope:end fail-closed-count */
  };
}
