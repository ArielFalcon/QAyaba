/*
 * What the authenticated browser an agent drives may request. Pure: one decision per request, from the run's declared
 * origins and two lists the app's config names (routes never to be reached, mutating requests that are allowed). The
 * browser the orchestrator hosts asks it for every request of its context, subresources and redirects included, so a page
 * cannot bring in what a tool call could not ask for. It stands on top of the egress filter, never instead of it: the
 * filter holds the network of the process, this holds what the agent can make that process do.
 *
 * Order: scheme, origin, denied route, method. A denied route is closed to every method and wins over an allowance.
 */

import { compileEgressPolicy } from "../../../shared-infrastructure/egress/egress-policy.ts";

export const GUARD_REASON = {
  SCHEME: "scheme",
  ORIGIN: "origin",
  DENY_ROUTE: "deny-route",
  METHOD: "method",
} as const;

export type GuardReason = (typeof GUARD_REASON)[keyof typeof GUARD_REASON];

export interface GuardRequest {
  method: string;
  url: string;
}

export type GuardDecision = { allow: true } | { allow: false; reason: GuardReason; detail: string };

export interface RouteGuardPolicy {
  /* The origins the run declares (`scheme://host[:port]`, `scheme://*.suffix[:port]`): the same list the egress filter holds the sandbox to. */
  origins: readonly string[];
  /* Absolute paths (`*` within one segment, `**` across segments, a trailing `/**` also covers the path itself) closed to every method. */
  denyRoutes: readonly string[];
  /* `[METHOD ]/path` entries: a request with a method that writes is let through only when one matches. */
  allowMutating: readonly string[];
}

export interface RouteGuard {
  decide(request: GuardRequest): GuardDecision;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
/* Schemes that reach no network: a page's own data. */
const LOCAL_SCHEMES: ReadonlySet<string> = new Set(["about:", "data:", "blob:"]);
const SOCKET_SCHEME: Readonly<Record<string, string>> = { "ws:": "http:", "wss:": "https:" };
const PATTERN_CHARS = /^[A-Za-z0-9._~\-/*:@!$&'()+,;=%]+$/;
const MAX_PATTERN_CHARS = 200;

export function routePatternError(pattern: string): string | undefined {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_CHARS) return `must be 1-${MAX_PATTERN_CHARS} characters`;
  if (!pattern.startsWith("/")) return "must be an absolute path starting with /";
  if (!PATTERN_CHARS.test(pattern)) return "may hold only path characters (no query, fragment, space or scheme)";
  if (pattern.includes("***")) return "has a run of more than two *";
  return undefined;
}

export function mutatingEntryError(entry: string): string | undefined {
  const match = /^(?:([A-Z]+) )?(\/.*)$/.exec(entry);
  if (!match) return 'must be "/path" or "METHOD /path"';
  if (match[1] !== undefined && !(MUTATING_METHODS as readonly string[]).includes(match[1])) return `the method must be one of ${MUTATING_METHODS.join(", ")}`;
  return routePatternError(match[2]!);
}

function patternToRegExp(pattern: string, flags: string): RegExp {
  const deep = pattern.endsWith("/**");
  const body = deep ? pattern.slice(0, -3) : pattern;
  let source = "";
  for (let i = 0; i < body.length; ) {
    if (body.startsWith("**", i)) {
      source += ".*";
      i += 2;
    } else if (body[i] === "*") {
      source += "[^/]*";
      i += 1;
    } else {
      source += body[i]!.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${source}${deep ? "(?:/.*)?" : ""}$`, flags);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/* A path as a server may read it: dot segments resolved by the URL parser, empty segments collapsed, percent-escapes decoded, `;params` dropped, case folded, no trailing slash. A route is denied in whatever spelling reaches it. */
function denyForm(pathname: string): string {
  const segments = pathname
    .split("/")
    .filter((s) => s !== "")
    .map((s) => decodeSegment(s).split(";")[0]!.toLowerCase());
  return `/${segments.join("/")}`;
}

/* The address without what must not travel into a message: query, fragment and credentials. */
function describe(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

interface MutatingEntry {
  method: string | undefined;
  path: RegExp;
}

export function createRouteGuard(policy: RouteGuardPolicy): RouteGuard {
  const origins = compileEgressPolicy(policy.origins);
  const deny = policy.denyRoutes.map((pattern) => patternToRegExp(pattern.toLowerCase(), ""));
  const allow: MutatingEntry[] = policy.allowMutating.map((entry) => {
    const match = /^(?:([A-Z]+) )?(\/.*)$/.exec(entry)!;
    return { method: match[1], path: patternToRegExp(match[2]!, "") };
  });

  return {
    decide(request) {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return { allow: false, reason: GUARD_REASON.SCHEME, detail: "the address could not be read" };
      }
      if (LOCAL_SCHEMES.has(url.protocol)) return { allow: true };
      const scheme = SOCKET_SCHEME[url.protocol] ?? url.protocol;
      if (scheme !== "http:" && scheme !== "https:") return { allow: false, reason: GUARD_REASON.SCHEME, detail: `${url.protocol} addresses are not reachable` };
      const port = url.port !== "" ? Number(url.port) : scheme === "https:" ? 443 : 80;
      if (!origins.allows(url.hostname, port)) return { allow: false, reason: GUARD_REASON.ORIGIN, detail: `${url.origin} is not an origin of this run` };
      const path = denyForm(url.pathname);
      if (deny.some((re) => re.test(path))) return { allow: false, reason: GUARD_REASON.DENY_ROUTE, detail: `${url.pathname} is a route this app closes to the agent` };
      const method = request.method.toUpperCase();
      if (SAFE_METHODS.has(method)) return { allow: true };
      if (allow.some((entry) => (entry.method === undefined || entry.method === method) && entry.path.test(url.pathname))) return { allow: true };
      return { allow: false, reason: GUARD_REASON.METHOD, detail: `${method} ${describe(url)} would write to DEV` };
    },
  };
}
