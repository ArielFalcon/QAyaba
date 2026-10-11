/* How a route template of the map becomes a page that can be opened. The map names `/shops/:province/:city`; the site shows `/shops/madrid/madrid` in a link. Nothing is guessed: an instance is a link the site really showed, matched to the template segment by segment, so the page it names exists. Pure and deterministic: the first match in the order the links were harvested wins. */

import { classifyRoute } from "../../../shared-kernel/route-capturability.ts";

/* The most links one page contributes, and the longest one may be: a page is not under the orchestrator's control, so what it reports is bounded where it is read. */
export const MAX_LINKS_PER_PAGE = 200;
export const MAX_LINK_LENGTH = 512;

/* A parameter that fills one whole segment, in the three spellings route templates use. A modifier (`:id?`), a pattern (`:id(\d+)`), a catch-all (`[...rest]`) or a parameter mixed with text names a page of no fixed form, so it is not one. */
const PARAMETER_SEGMENT = /^(?::[A-Za-z0-9_]+|\{[A-Za-z0-9_.-]+\}|\[[A-Za-z0-9_-]+\])$/;
/* What marks a segment as a template that is not a whole-segment parameter: it opens with a colon, or holds a brace, a bracket or a wildcard. A colon inside a name (`report:2024`) is part of a real address. */
const PARTIAL_TEMPLATE = /^:|[{}[\]*]/;

type Segment = { parameter: true } | { parameter: false; text: string };

/* The segments of a template of the form this module can fill, or nothing. */
function templateSegments(template: string): Segment[] | undefined {
  if (!template.startsWith("/") || /[?#]/.test(template)) return undefined;
  const segments: Segment[] = [];
  for (const text of template.split("/").filter((part) => part !== "")) {
    if (PARAMETER_SEGMENT.test(text)) segments.push({ parameter: true });
    else if (PARTIAL_TEMPLATE.test(text)) return undefined;
    else segments.push({ parameter: false, text });
  }
  return segments.some((segment) => segment.parameter) ? segments : undefined;
}

/** Whether a template is made of literal segments and whole-segment parameters, with at least one parameter: the only templates a real link can fill. */
export function instantiableTemplate(template: string): boolean {
  return templateSegments(template) !== undefined;
}

/* The segments of a link's pathname, or nothing when it is not a plain path of the site: no query or hash is kept, a trailing slash is no segment, and an empty segment inside the path changes what the path means. */
function linkSegments(link: string): string[] | undefined {
  if (!link.startsWith("/") || link.startsWith("//")) return undefined;
  const path = link.split(/[?#]/, 1)[0] ?? "";
  const parts = path.split("/").slice(1);
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.includes("") ? undefined : parts;
}

/* Whether the leading segments of a link fill the template: literals equal, a parameter any one segment. */
const fills = (template: readonly Segment[], link: readonly string[]): boolean =>
  template.every((segment, index) => segment.parameter || segment.text === link[index]);

/* The route a link gives for a template of `length` segments: the link's own leading segments, when a browser can open them as written. */
function instanceOf(link: readonly string[], length: number): string | undefined {
  const route = `/${link.slice(0, length).join("/")}`;
  return classifyRoute(route).capturable ? route : undefined;
}

/**
 * The page a template names, as the links of the site show it: the first link of the same length whose segments fill the template, else the first longer link whose leading segments do (a list page the site only links through its detail pages). Undefined when the template is not one this module fills, or no link fits.
 */
export function instantiateRoute(template: string, links: readonly string[]): string | undefined {
  const segments = templateSegments(template);
  if (segments === undefined) return undefined;
  const candidates = links.map(linkSegments).filter((link): link is string[] => link !== undefined && link.length >= segments.length && fills(segments, link));
  for (const link of candidates) {
    if (link.length === segments.length) {
      const exact = instanceOf(link, segments.length);
      if (exact !== undefined) return exact;
    }
  }
  for (const link of candidates) {
    if (link.length > segments.length) {
      const derived = instanceOf(link, segments.length);
      if (derived !== undefined) return derived;
    }
  }
  return undefined;
}

/**
 * The pathnames of the links a page showed that lead to the site's own origin, in page order, once each, and bounded. The hrefs come from the page, so each is checked here: what is not a string, not an address, on another origin or too long is skipped, and a query or hash is no part of the path.
 */
export function sameOriginPathnames(hrefs: unknown, baseUrl: string): string[] {
  if (!Array.isArray(hrefs)) return [];
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return [];
  }
  const paths = new Set<string>();
  for (const href of hrefs) {
    if (paths.size >= MAX_LINKS_PER_PAGE) break;
    if (typeof href !== "string") continue;
    try {
      const url = new URL(href);
      if (url.origin === origin && url.pathname.length <= MAX_LINK_LENGTH) paths.add(url.pathname);
    } catch {
      /* not an address: no link */
    }
  }
  return [...paths];
}
