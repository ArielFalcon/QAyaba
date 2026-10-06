/*
 * Whether a route string names ONE page a browser can open as written. A route template (`/product/:id`,
 * `/users/{id}`, `/blog/[slug]`, a wildcard), free text, an interpolation or an address on another host
 * names no such page: opening it renders a not-found page, or leaves the app's own origin. Such a route is
 * not captured, and it is told apart from a page that was captured and came back empty or redirected.
 * A query, a hash route and a colon inside a segment (`/files/report:2024`) are all part of a real address.
 * Pure and deterministic: the same text always gets the same answer.
 */

export const ROUTE_REASON = {
  EMPTY: "empty",
  TEMPLATE: "template",
  FREE_TEXT: "free-text",
  ABSOLUTE_URL: "absolute-url",
  INTERPOLATION: "interpolation",
} as const;

export type RouteReason = (typeof ROUTE_REASON)[keyof typeof ROUTE_REASON];

export type RouteClassification = { capturable: true } | { capturable: false; reason: RouteReason };

export interface UncapturableRoute {
  route: string;
  reason: RouteReason;
}

export interface RoutePartition {
  capturable: string[];
  uncapturable: UncapturableRoute[];
}

/* Another host: a protocol-relative address, or anything that opens with a scheme (`https:`, `javascript:`, `mailto:`). A scheme needs no slashes, so `mailto:a@b` counts. */
const OTHER_HOST = /^(?:\/\/|[A-Za-z][A-Za-z0-9+.-]*:)/;
/* Not one plain address: whitespace, a control character, or a backslash (a browser reads `/\host` as `//host`). */
const NOT_A_PATH = /[\s\\\x00-\x1f\x7f]/;
/* A parameter standing alone as a path segment (`/:id`, `:id/edit`, `#/product/:id`), or a brace, a bracket or a wildcard anywhere. A colon inside a segment is not a parameter. */
const PARAMETER = /(?:^|\/):[^/?#]|[{}[\]*]/;

export function classifyRoute(route: string): RouteClassification {
  const text = route.trim();
  const reason = reasonFor(text);
  return reason === undefined ? { capturable: true } : { capturable: false, reason };
}

function reasonFor(text: string): RouteReason | undefined {
  if (text === "") return ROUTE_REASON.EMPTY;
  if (text.includes("${")) return ROUTE_REASON.INTERPOLATION;
  if (OTHER_HOST.test(text)) return ROUTE_REASON.ABSOLUTE_URL;
  if (NOT_A_PATH.test(text)) return ROUTE_REASON.FREE_TEXT;
  if (PARAMETER.test(text)) return ROUTE_REASON.TEMPLATE;
  return undefined;
}

/** Splits routes into those that can be captured and those that cannot, each trimmed and listed once in the order asked. An empty entry asked for nothing and is in neither list. */
export function partitionRoutes(routes: readonly string[]): RoutePartition {
  const partition: RoutePartition = { capturable: [], uncapturable: [] };
  const seen = new Set<string>();
  for (const raw of routes) {
    const route = raw.trim();
    if (route === "" || seen.has(route)) continue;
    seen.add(route);
    const reason = reasonFor(route);
    if (reason === undefined) partition.capturable.push(route);
    else partition.uncapturable.push({ route, reason });
  }
  return partition;
}
