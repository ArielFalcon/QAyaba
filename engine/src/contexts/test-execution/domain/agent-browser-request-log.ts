/*
 * The requests a page of the authenticated browser made since the session's previous action, kept for the next answer.
 * Pure. A request is kept as method + origin + pathname: never its query, fragment, body, headers, cookies or userinfo.
 * A request to an origin the run declares (the kernel classifier, `requestOriginClassifier`, which the route guard applies and
 * the Context Pack's capture shares) is listed, marked when the guard blocked it for its route or method; a request to any
 * other host (or an address that is not http) only adds to that host's count, with no path. The page is untrusted, so the log is bounded for safety against one that never stops asking: past the bounds a
 * new distinct request is only counted as omitted. The bounds protect the orchestrator, they are not a cap on what an agent is shown.
 * What is kept, and the bounds, are the kernel ledger's (`@kernel/observed-requests.ts`), shared with the Context Pack's DOM capture.
 */

import type { GuardDecision } from "./agent-browser-route-guard.ts";
import type { ObservedRequests } from "./agent-browser-host.ts";
import { RequestLedger, requestAddress, type RequestOriginRole } from "@kernel/observed-requests.ts";

export { MAX_LOGGED_HOSTS, MAX_LOGGED_PATH_CHARS, MAX_LOGGED_REQUESTS, MAX_LOGGED_TOTAL_CHARS } from "@kernel/observed-requests.ts";

/* Schemes that reach no network: a page's own data. */
const LOCAL_SCHEMES: ReadonlySet<string> = new Set(["about:", "data:", "blob:"]);

export class RequestLog {
  private readonly ledger = new RequestLedger();

  constructor(private readonly originRole: (url: string) => RequestOriginRole) {}

  /* One request the context made and what the guard decided for it. */
  record(request: { method: string; url: string }, decision: GuardDecision): void {
    const address = requestAddress(request.url);
    if (address === undefined) return;
    if (LOCAL_SCHEMES.has(address.protocol)) return;
    if (this.originRole(request.url) === "counted-by-host") {
      this.ledger.addHost(address.host !== "" ? address.host : address.protocol, 1);
      return;
    }
    this.ledger.addListed(request.method.toUpperCase(), address.address, !decision.allow, 1);
  }

  /* What was kept, in the order it was first seen; the log is empty after. */
  drain(): ObservedRequests {
    return this.ledger.drain();
  }
}

/* Two reports of the same session, one after the other, as one. */
export function mergeObserved(first: ObservedRequests, second: ObservedRequests): ObservedRequests {
  const ledger = new RequestLedger();
  ledger.absorb(first);
  ledger.absorb(second);
  return ledger.drain();
}
