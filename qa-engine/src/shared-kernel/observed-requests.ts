/*
 * The requests a page made, kept as method + origin + pathname with a count: never the query, fragment, body, headers, cookies or
 * userinfo. One ledger and one set of bounds for every observer of a page's requests (the authenticated browser's log, the Context
 * Pack's DOM capture), so what is kept, what is cut and what is only counted cannot differ between them. The page is untrusted: the
 * ledger is bounded against one that never stops asking, and past the bounds a new distinct request is only counted as omitted. The
 * bounds protect the orchestrator; they are not a cap on what an agent is shown. Pure.
 */

/* A request the page made, as method + origin + pathname (no query, fragment, body, headers, cookies or userinfo), with how many times. */
export interface ObservedRequest {
  method: string;
  url: string;
  count: number;
  /* The request did not complete: a guard refused it (a closed route, a method that writes), or the network, the egress filter or the page ended it. */
  blocked?: true;
}

/* The requests the page made over a span: those to an origin the observer lists, those to any other host only counted per host. */
export interface ObservedRequests {
  listed: ObservedRequest[];
  otherHosts: { host: string; count: number }[];
  /* Requests not kept because the page asked for more distinct ones than the safety bound holds. */
  omitted: number;
}

/* Safety bounds against a page that tries to exhaust the orchestrator or flood an answer (the page is untrusted); none is a cap on what an agent should be shown. */
/* Distinct listed requests and distinct other hosts kept in one ledger. */
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

/* The address a request is kept by: its origin and pathname, or undefined when it is no URL. */
export function requestAddress(url: string): { origin: string; address: string; protocol: string; host: string } | undefined {
  try {
    const parsed = new URL(url);
    return { origin: parsed.origin, address: `${parsed.origin}${parsed.pathname}`, protocol: parsed.protocol, host: parsed.host };
  } catch {
    return undefined;
  }
}

interface Listed {
  method: string;
  url: string;
  count: number;
  blocked: boolean;
}

export class RequestLedger {
  private readonly listed = new Map<string, Listed>();
  private readonly hosts = new Map<string, number>();
  private omitted = 0;
  /* The characters of the keys held now. */
  private chars = 0;

  addListed(method: string, address: string, blocked: boolean, count: number): void {
    const url = bounded(address);
    const key = `${blocked ? "!" : ""}${method} ${url}`;
    const held = this.listed.get(key);
    if (held) held.count += count;
    else if (this.listed.size < MAX_LOGGED_REQUESTS && this.fits(url)) this.listed.set(key, { method, url, count, blocked });
    else this.omitted += count;
  }

  addHost(name: string, count: number): void {
    const host = bounded(name);
    const held = this.hosts.get(host);
    if (held !== undefined) this.hosts.set(host, held + count);
    else if (this.hosts.size < MAX_LOGGED_HOSTS && this.fits(host)) this.hosts.set(host, count);
    else this.omitted += count;
  }

  /* Requests the ledger was told of but cannot name (an observer that bounded them first). */
  addOmitted(count: number): void {
    this.omitted += count;
  }

  /* Takes what another ledger kept into this one. */
  absorb(kept: ObservedRequests): void {
    for (const r of kept.listed) this.addListed(r.method, r.url, r.blocked === true, r.count);
    for (const h of kept.otherHosts) this.addHost(h.host, h.count);
    this.omitted += kept.omitted;
  }

  /* What was kept, in the order it was first seen; the ledger is empty after. */
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

  /* Whether a new key still fits the total, and if so charges it. */
  private fits(key: string): boolean {
    if (this.chars + key.length > MAX_LOGGED_TOTAL_CHARS) return false;
    this.chars += key.length;
    return true;
  }
}
