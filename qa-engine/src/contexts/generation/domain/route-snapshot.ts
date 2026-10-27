/* What one DOM capture reports of a route, as the capture script writes it and the grounding reads it. */
import type { ObservedRequest } from "@kernel/observed-requests.ts";

export interface NodeAttr {
  key: string;
  testId?: string;
  id?: string;
  name?: string;
  href?: string;
  inputType?: string;
  nameFallback?: string;
}

/* An occurrence, in page order, of a name its page repeats. `group` is the role and the name's words (`button|cambiar filtros`: case, punctuation and icon glyphs aside, as a locator matches it); `of` occurrences share it; `scope` lists the containers (nearest first) this one is in and some other one is not, each written as a locator names it: `[test-id="v"]`, `#id` or a custom element's tag. Empty when nothing on the way up tells it apart. */
export interface RepeatedName {
  group: string;
  of: number;
  scope: string[];
}

/* The data requests (fetch, XHR) a page's code made while it was captured, as the kernel ledger keeps them: method + origin + pathname with a count, and how many the safety bounds left out. */
export interface PageRequests {
  listed: ObservedRequest[];
  omitted: number;
}

export interface RouteSnapshot {
  route: string;
  nodes?: string[];
  attrs?: NodeAttr[];
  states?: Map<string, string[]>;
  testIdAttrName?: string;
  testIds?: Map<string, number>;
  settled?: boolean; /* Absent/false ⇒ possibly pre-hydration ⇒ advisory only. */
  error?: string; /* capture failed for this route (degrade — never blocks review) */
  runtimeErrors?: { type: string; text: string }[];
  finalUrl?: string;
  /* The pathnames of the same-origin links the page showed, in page order and once each: the real addresses a route template is filled from. */
  links?: string[];
  /* Set on a page opened from a route template of the map: the template `route` is an instance of. */
  template?: string;
  /* Milliseconds the capture script spent on this route (navigation, settling and reading), as the script measured them. */
  ms?: number;
  /* One entry per occurrence, in page order, of each name the page shows more than once for the same role. */
  repeated?: RepeatedName[];
  /* The containers the capture was asked about that this page shows none of (see CaptureDomDeps.render's probe). */
  absent?: string[];
  /* A config-declared data state matched this route (dev.dataState), so its readiness/result/location were read at capture time. */
  dataState?: boolean;
  /* The route's readiness selector was found within the timeout. Absent when no data state matched. */
  ready?: boolean;
  /* A result selector/text was configured for the route, so `resultCount` is what the capture counted. */
  resultExpected?: boolean;
  /* Results counted on the route (the first integer of the result text, or the result selector's count). */
  resultCount?: number;
  /* The count was read as 0 on two reads of a settled page (no data request in flight, the tree unchanged between them): a real empty state, neither a page with results nor an unconfirmed one. */
  emptyConfirmed?: boolean;
  /* The route's effective location, read from its configured location selector (trim/collapse/200 chars). */
  effectiveLocation?: string;
  /* How many times the route's data state was read (1, or 2 after the one retry). Set only when a data state matched. */
  captureAttempts?: number;
  /* The HTTP status of the document the navigation kept. */
  documentStatus?: number;
  /* How many server redirects led to that document. */
  serverRedirects?: number;
  /* The pathname the document was served at (after the server redirects, before any the page made). */
  documentPath?: string;
  /* Whether the capture opened the route with the run's saved session. */
  sessionAttached?: boolean;
  /* The data requests the page made while it was captured. Absent when it made none. */
  requests?: PageRequests;
}
