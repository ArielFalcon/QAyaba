/*
 * The requests a page of the authenticated browser made since the session's previous action, kept for the next answer.
 * Pure. A request is kept as method + origin + pathname: never its query, fragment, body, headers, cookies or userinfo.
 * A request the route guard let through, or blocked for its route or method, is listed (the origin is one the run declares);
 * a request to a host the run does not declare (or an address that is not http) only adds to that host's count, with no
 * path. The page is untrusted, so the log is bounded for safety against one that never stops asking: past the bounds a
 * new distinct request is only counted as omitted. The bounds protect the orchestrator, they are not a cap on what an agent is shown.
 */

import type { GuardDecision } from "./agent-browser-route-guard.ts";
import { GUARD_REASON } from "./agent-browser-route-guard.ts";
import type { ObservedRequests } from "./agent-browser-host.ts";

/* Safety bounds against a page that tries to exhaust the orchestrator or flood an answer (the page is untrusted); none is a cap on what an agent should be shown. */
/* Distinct listed requests and distinct other hosts kept between two answers. */
export const MAX_LOGGED_REQUESTS = 200;
export const MAX_LOGGED_HOSTS = 50;
/* The characters of one kept address (origin + pathname) or host: a page can ask for an address of any length. */
export const MAX_LOGGED_PATH_CHARS = 500;
/* The characters of every kept address and host together, checked when a request is recorded, so memory and the answer stay bounded however long the addresses are. */
export const MAX_LOGGED_TOTAL_CHARS = 24_000;
const CUT_MARK = "…[cut]";

/* An address or host past the bound is cut and says so; cutting a cut one changes nothing. */
function bounded(text: string): string {
  return text.length <= MAX_LOGGED_PATH_CHARS ? text : `${text.slice(0, MAX_LOGGED_PATH_CHARS)}${CUT_MARK}`;
}
/* Schemes that reach no network: a page's own data. */
const LOCAL_SCHEMES: ReadonlySet<string> = new Set(["about:", "data:", "blob:"]);

interface Listed {
  method: string;
  url: string;
  count: number;
  blocked: boolean;
}

export class RequestLog {
  private readonly listed = new Map<string, Listed>();
  private readonly hosts = new Map<string, number>();
  private omitted = 0;
  /* The characters of the keys held now. */
  private chars = 0;

  /* One request the context made and what the guard decided for it. */
  record(request: { method: string; url: string }, decision: GuardDecision): void {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return;
    }
    if (LOCAL_SCHEMES.has(url.protocol)) return;
    const foreign = !decision.allow && (decision.reason === GUARD_REASON.ORIGIN || decision.reason === GUARD_REASON.SCHEME);
    if (foreign) {
      this.addHost(url.host !== "" ? url.host : url.protocol, 1);
      return;
    }
    this.addListed(request.method.toUpperCase(), `${url.origin}${url.pathname}`, !decision.allow, 1);
  }

  /* Takes what another log kept (requests no page could be named for) into this one. */
  absorb(kept: ObservedRequests): void {
    for (const r of kept.listed) this.addListed(r.method, r.url, r.blocked === true, r.count);
    for (const h of kept.otherHosts) this.addHost(h.host, h.count);
    this.omitted += kept.omitted;
  }

  /* What was kept, in the order it was first seen; the log is empty after. */
  drain(): ObservedRequests {
    const out: ObservedRequests = {
      listed: [...this.listed.values()].map((r) => ({ method: r.method, url: r.url, count: r.count, ...(r.blocked ? { blocked: true as const } : {}) })),
      otherHosts: [...this.hosts].map(([host, count]) => ({ host, count })),
      omitted: this.omitted,
    };
    this.listed.clear();
    this.hosts.clear();
    this.omitted = 0;
    this.chars = 0;
    return out;
  }

  private addListed(method: string, address: string, blocked: boolean, count: number): void {
    const url = bounded(address);
    const key = `${blocked ? "!" : ""}${method} ${url}`;
    const held = this.listed.get(key);
    if (held) held.count += count;
    else if (this.listed.size < MAX_LOGGED_REQUESTS && this.fits(url)) this.listed.set(key, { method, url, count, blocked });
    else this.omitted += count;
  }

  private addHost(name: string, count: number): void {
    const host = bounded(name);
    const held = this.hosts.get(host);
    if (held !== undefined) this.hosts.set(host, held + count);
    else if (this.hosts.size < MAX_LOGGED_HOSTS && this.fits(host)) this.hosts.set(host, count);
    else this.omitted += count;
  }

  /* Whether a new key still fits the total, and if so charges it. */
  private fits(key: string): boolean {
    if (this.chars + key.length > MAX_LOGGED_TOTAL_CHARS) return false;
    this.chars += key.length;
    return true;
  }
}

/* Two reports of the same session, one after the other, as one. */
export function mergeObserved(first: ObservedRequests, second: ObservedRequests): ObservedRequests {
  const log = new RequestLog();
  log.absorb(first);
  log.absorb(second);
  return log.drain();
}
