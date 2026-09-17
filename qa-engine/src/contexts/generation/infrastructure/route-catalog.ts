/* Route catalog: the single grounding artifact the agent transcribes from and the pre-execution gate verifies against. Pure construction — no browser. */

import type { RouteSnapshot } from "./dom-snapshot.ts";

/** Single source of truth for the route capture status values. A const object keeps runtime values alongside the type and avoids string-literal / type divergence. */
export const ROUTE_STATUS = {
  CAPTURED: "captured",
  DEGRADED: "degraded",
} as const;

/** Route capture status: "captured" = render succeeded; "degraded" = errored / timed-out / auth-blocked. */
export type RouteStatus = (typeof ROUTE_STATUS)[keyof typeof ROUTE_STATUS];

/** Per-route catalog of selectors that exist in the captured live DOM, one index per family. status/settled gate whether the fail-closed path may trust it. */
export interface RouteCatalog {
  route: string;
  status: RouteStatus;
  settled: boolean;
  /** test-id value → occurrence count. Presence answers whether getByTestId exists; count > 1 flags a strict-mode ambiguity that would otherwise surface only at runtime. */
  testIds: Map<string, number>;
}

/** Build the test-id index from the raw, role-independent capture (every element carrying the configured testIdAttribute, including role-less elements). Counts occurrences so presence and uniqueness are checkable. Blank values are ignored. */
export function buildTestIdIndex(capturedValues: readonly string[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const raw of capturedValues) {
    const value = raw.trim();
    if (!value) continue;
    index.set(value, (index.get(value) ?? 0) + 1);
  }
  return index;
}

const FRAMEWORK_ERROR_RE = /\bNG\d+\b|ERROR Error:|Uncaught|Unhandled Promise rejection/;
const BENIGN_NOISE_RE = /Failed to load resource|favicon|net::ERR_/i;

/** Advisory only: a genuine app-defect signature (uncaught pageerror, or a console entry matching FRAMEWORK_ERROR_RE after excluding benign transport noise). Grounding trust is structural, not app-health. */
export function hasRuntimeErrorSignal(errors: readonly { type: string; text: string }[]): boolean {
  for (const e of errors) {
    if (e.type === "pageerror") return true;
    if (BENIGN_NOISE_RE.test(e.text)) continue;
    if (FRAMEWORK_ERROR_RE.test(e.text)) return true;
  }
  return false;
}

/** True when the settled finalUrl pathname diverges from the requested route pathname (a redirect). Both sides are parsed as URLs so query/hash — including hash-router paths — cannot count as a path mismatch. Trailing slashes are normalized. A hash-only redirect is undetectable here: an ambiguous signal defaults to trust, never degrade. */
function isRedirect(route: string, finalUrl: string | undefined): boolean {
  if (!finalUrl) return false;
  let finalPath: string;
  let requestedPath: string;
  try {
    finalPath = new URL(finalUrl).pathname;
    requestedPath = new URL(route, "http://q.invalid").pathname;
  } catch {
    return false;
  }
  const normalize = (p: string): string => {
    const withSlash = p.startsWith("/") ? p : `/${p}`;
    return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
  };
  return normalize(finalPath) !== normalize(requestedPath);
}

/** Pure adapter from RouteSnapshot to RouteCatalog. Capture error → degraded (never trusted). Unconfirmed settle → settled:false. The fail-closed path may trust ONLY a captured && settled route; unknown defaults to advisory, never a false block. Also degraded (safe direction: removes trust, never blocks) when nodes[] is empty or finalUrl redirected away from the requested route. */
export function buildRouteCatalog(snapshot: RouteSnapshot): RouteCatalog {
  const captureFailed = snapshot.error !== undefined;
  const emptyRender = !captureFailed && (snapshot.nodes?.length ?? 0) === 0;
  const redirected = !captureFailed && isRedirect(snapshot.route, snapshot.finalUrl);
  /* Grounding trust is structural render (captureFailed / emptyRender / redirect), not whether the app logged a runtime error. Runtime errors are adjudication evidence, not a catalog degrade. */
  const degraded = captureFailed || emptyRender || redirected;
  return {
    route: snapshot.route,
    status: degraded ? ROUTE_STATUS.DEGRADED : ROUTE_STATUS.CAPTURED,
    settled: !degraded && snapshot.settled === true,
    testIds: degraded ? new Map() : (snapshot.testIds ?? new Map()),
  };
}

/** Names every route whose capture degraded, or undefined when every route captured. Unsettled routes are not named here — present-but-unsettled is expected on SPAs and stays advisory. */
export function degradedRouteWarning(catalogs: readonly RouteCatalog[]): string | undefined {
  const degraded = catalogs.filter((c) => c.status === ROUTE_STATUS.DEGRADED).map((c) => c.route);
  if (degraded.length === 0) return undefined;
  return `[qa] WARNING: DOM capture DEGRADED for ${degraded.length} route(s) [${degraded.join(", ")}] — these routes are NOT grounded; the selector gate treats them as advisory (no fail-closed).`;
}
