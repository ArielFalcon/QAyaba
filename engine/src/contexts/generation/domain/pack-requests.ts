/*
 * The data requests (fetch, XHR) each captured page made while the Context Pack's DOM capture read it, as a section of the pack: one fact
 * per request, `- <page>: <METHOD> <origin><path> (×count)` (the caller writes the heading, with `REQUESTS_SECTION_INTRO`), in the order the page first made them. A request is method + origin + pathname,
 * never a query, fragment, body, header, cookie or userinfo (the kernel ledger's rule, shared with the authenticated browser's log), and
 * only the requests to an origin the run declares are listed; those to any other host are one line of the page counting them per host,
 * and what the capture's safety bounds left out is another. Neither count line is a request.
 * The facts give way to a count over a prompt's window (`referenceSectionFacts`), and a flow's brief carries those of its pages
 * (`packPagesFor`, `recordedRequestsFor`). Pure.
 */
import type { PageRequests } from "./route-snapshot.ts";
import { PRINTED_ROUTE_SOURCE, printedRoute } from "@kernel/printed-route.ts";

/* A captured page and the requests it made: its address, and the template of the map it was opened from when it was. */
export interface PageRequestFacts {
  route: string;
  template?: string;
  requests: PageRequests;
}

/* How the section introduces itself: what the facts are and what they are not. */
export const REQUESTS_SECTION_INTRO = `(data requests — fetch and XHR — the page's code made while it was captured, as method + origin + path with a count; never a query, body or header)`;

const OTHER_HOSTS_LEAD = "requests to hosts the run does not declare, counted per host:";

/* The section's facts, or none when no page made a request. */
export function requestsSectionLines(pages: readonly PageRequestFacts[]): string[] {
  const facts = pages.flatMap((page) => {
    const label = printedRoute(page);
    const listed = page.requests.listed.map((r) => `- ${label}: ${r.method} ${r.url}${r.count > 1 ? ` (×${r.count})` : ""}${r.blocked ? " [did not complete]" : ""}`);
    const hosts = page.requests.otherHosts.length > 0 ? [`- ${label}: (${OTHER_HOSTS_LEAD} ${page.requests.otherHosts.map((h) => `${h.host} ×${h.count}`).join(", ")})`] : [];
    const omitted = page.requests.omitted > 0 ? [`- ${label}: (+${page.requests.omitted} more request(s) not kept, past the capture's safety bound)`] : [];
    return [...listed, ...hosts, ...omitted];
  });
  return facts;
}

/* A fact of the section, read back: the page it is of (address, and the template when it has one), the request it states, and whether it only counts requests (to other hosts, or left out by the capture) instead of stating one. */
export interface RequestFact {
  route: string;
  template?: string;
  request: string;
  isCountLine: boolean;
}

const FACT_LINE = new RegExp(`^- ${PRINTED_ROUTE_SOURCE}: (.*)$`);
const COUNT_LINE = new RegExp(`^\\((?:\\+\\d+ more request\\(s\\)|${OTHER_HOSTS_LEAD})`);

export function requestFactOf(line: string): RequestFact | undefined {
  const match = FACT_LINE.exec(line);
  if (!match) return undefined;
  return { route: match[1]!, ...(match[2] !== undefined ? { template: match[2] } : {}), request: match[3]!, isCountLine: COUNT_LINE.test(match[3]!) };
}
