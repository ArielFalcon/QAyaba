/* Route catalog: the single grounding artifact the agent transcribes from and the pre-execution gate verifies against. Pure construction — no browser. */

import type { RouteSnapshot } from "./dom-snapshot.ts";

/** Single source of truth for the route capture status values. A const object keeps runtime values alongside the type and avoids string-literal / type divergence. */
export const ROUTE_STATUS = {
  CAPTURED: "captured",
  DEGRADED: "degraded",
} as const;

/** Route capture status: "captured" = render succeeded; "degraded" = errored / timed-out / auth-blocked. */
export type RouteStatus = (typeof ROUTE_STATUS)[keyof typeof ROUTE_STATUS];

/** Why a route degraded: its capture failed, it rendered no nodes, or the browser ended on another page. */
export const DEGRADE_REASON = {
  CAPTURE_FAILED: "capture-failed",
  EMPTY_RENDER: "empty-render",
  REDIRECTED: "redirected",
} as const;

export type DegradeReason = (typeof DEGRADE_REASON)[keyof typeof DEGRADE_REASON];

/** The longest path a redirect is named by: the path comes from the app, and it reaches a prompt and a log. */
export const REDIRECT_PATH_MAX_CHARS = 200;

/** Per-route catalog of selectors that exist in the captured live DOM, one index per family. status/settled gate whether the fail-closed path may trust it. */
export interface RouteCatalog {
  route: string;
  status: RouteStatus;
  settled: boolean;
  /** test-id value → occurrence count. Presence answers whether getByTestId exists; count > 1 flags a strict-mode ambiguity that would otherwise surface only at runtime. */
  testIds: Map<string, number>;
  /** Why the route degraded; absent when it captured. */
  degradeReason?: DegradeReason;
  /** The page the browser ended on, when the route redirected: the path alone, without query or fragment (origin and path when it left the app's origin). */
  redirectedTo?: string;
  /** Whether the page a redirect reached has a password field (a login page); absent when the route did not redirect. */
  reachedPasswordField?: boolean;
  /** Whether the redirect left the app's origin (a central login); absent when the route did not redirect. */
  reachedOtherOrigin?: boolean;
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

/** The path the browser ended on when the settled finalUrl pathname diverges from the requested route pathname (a redirect); undefined otherwise. Both sides are parsed as URLs so query/hash — including hash-router paths — cannot count as a path mismatch. Trailing slashes are normalized. A hash-only redirect is undetectable here: an ambiguous signal defaults to trust, never degrade. */
function redirectTarget(route: string, finalUrl: string | undefined): string | undefined {
  if (!finalUrl) return undefined;
  let finalPath: string;
  let requestedPath: string;
  try {
    finalPath = new URL(finalUrl).pathname;
    requestedPath = new URL(route, "http://q.invalid").pathname;
  } catch {
    return undefined;
  }
  /* A URL's pathname always starts with a slash; a server may add trailing ones. */
  const normalize = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const reached = normalize(finalPath);
  return reached === normalize(requestedPath) ? undefined : reached.slice(0, REDIRECT_PATH_MAX_CHARS);
}

/** Names the page a capture ended on when it settled on another origin than the app (e.g. a central login). The origin is part of the name: the same path on the identity provider is not the app's own page, so a path match never hides the redirect. */
function offOriginTarget(finalUrl: string | undefined): string {
  try {
    const url = new URL(finalUrl ?? "");
    return `${url.origin}${url.pathname}`.slice(0, REDIRECT_PATH_MAX_CHARS);
  } catch {
    return "another origin";
  }
}

/** Pure adapter from RouteSnapshot to RouteCatalog. Capture error → degraded (never trusted). Unconfirmed settle → settled:false. The fail-closed path may trust ONLY a captured && settled route; unknown defaults to advisory, never a false block. Also degraded (safe direction: removes trust, never blocks) when nodes[] is empty or finalUrl redirected away from the requested route; a degraded route says why, and a redirect says where it led. */
export function buildRouteCatalog(snapshot: RouteSnapshot): RouteCatalog {
  const captureFailed = snapshot.error !== undefined;
  const emptyRender = !captureFailed && (snapshot.nodes?.length ?? 0) === 0;
  const offOrigin = snapshot.offOrigin === true;
  /* Another origin is named with its origin whatever its path: the same path elsewhere is not the app's page, and a different path on it must not read as the app's own. */
  const redirectedTo = captureFailed ? undefined : offOrigin ? offOriginTarget(snapshot.finalUrl) : redirectTarget(snapshot.route, snapshot.finalUrl);
  /* Grounding trust is structural render (captureFailed / emptyRender / redirect), not whether the app logged a runtime error. Runtime errors are adjudication evidence, not a catalog degrade. */
  const degradeReason = captureFailed
    ? DEGRADE_REASON.CAPTURE_FAILED
    : redirectedTo !== undefined
      ? DEGRADE_REASON.REDIRECTED
      : emptyRender
        ? DEGRADE_REASON.EMPTY_RENDER
        : undefined;
  const degraded = degradeReason !== undefined;
  return {
    route: snapshot.route,
    status: degraded ? ROUTE_STATUS.DEGRADED : ROUTE_STATUS.CAPTURED,
    settled: !degraded && snapshot.settled === true,
    testIds: degraded ? new Map() : (snapshot.testIds ?? new Map()),
    ...(degraded ? { degradeReason } : {}),
    ...(redirectedTo === undefined
      ? {}
      : { redirectedTo, reachedPasswordField: snapshot.attrs?.some((attr) => attr.inputType === "password") ?? false, reachedOtherOrigin: offOrigin }),
  };
}

/** Names every route whose capture degraded, each with why (and where a redirect led), or undefined when every route captured. Unsettled routes are not named here — present-but-unsettled is expected on SPAs and stays advisory. */
export function degradedRouteWarning(catalogs: readonly RouteCatalog[]): string | undefined {
  const degraded = catalogs.filter((c) => c.status === ROUTE_STATUS.DEGRADED);
  if (degraded.length === 0) return undefined;
  const named = degraded.map((c) => `${c.route} (${[c.degradeReason, c.redirectedTo].filter(Boolean).join(" ")})`);
  return `[qa] WARNING: DOM capture DEGRADED for ${degraded.length} route(s) [${named.join(", ")}] — these routes are NOT grounded; the selector gate treats them as advisory (no fail-closed).`;
}

/** A note, for the log only, when redirects look like a gated app: two or more routes reached one page, or the page reached has a password field. The app may need a login declared in its config: `auth:` when the page is on the app's own origin, `e2e.auth:` when it is another origin's (a central login). Undefined when nothing looks gated. */
export function gatedAppAdvisory(catalogs: readonly RouteCatalog[]): string | undefined {
  const reached = new Map<string, { routes: string[]; hasPasswordField: boolean; otherOrigin: boolean }>();
  for (const c of catalogs) {
    if (c.redirectedTo === undefined) continue;
    const page = reached.get(c.redirectedTo) ?? { routes: [], hasPasswordField: false, otherOrigin: false };
    page.routes.push(c.route);
    page.hasPasswordField ||= c.reachedPasswordField === true;
    page.otherOrigin ||= c.reachedOtherOrigin === true;
    reached.set(c.redirectedTo, page);
  }
  const gated = [...reached].filter(([, page]) => page.routes.length > 1 || page.hasPasswordField);
  if (gated.length === 0) return undefined;
  const named = gated.map(([path, page]) => `${path} (reached from ${page.routes.join(", ")})`);
  const blocks = [...(gated.some(([, page]) => !page.otherOrigin) ? ["auth: (a login on the app's own origin)"] : []), ...(gated.some(([, page]) => page.otherOrigin) ? ["e2e.auth: (a central login on another origin)"] : [])];
  return `[qa] NOTE: the app may be gated: ${named.join("; ")}. If it needs a login, declare ${blocks.join(" or ")} in its config.`;
}
