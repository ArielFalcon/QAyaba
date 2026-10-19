/*
 * The pure extractor over what the agent was given and what it did: the references to grounding items that appear in the delivered
 * spec text and the tool targets. A reference is an exact id (route/dom/op) built with the same helpers as the delivered ids, so
 * `referenced ⊆ delivered` is a set intersection, never a fuzzy match. Imported from `context-item-ids.ts`, not copied: the hash8
 * and the id builders are the single source, so a role name hashes to the same `dom:` id here and at capture time.
 *
 * This is a lower bound on use, not a verdict: a selector in a helper, a loop or a variable is unattributed (never a miss), and a
 * dynamic selector is simply not seen.
 */

import { hash8, itemId } from "@contexts/generation/domain/context-item-ids.ts";

/* One path, no query, no fragment, one leading slash. */
export function normalizeRoutePath(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0] ?? path;
  const trimmed = withoutQuery.trim().replace(/^\/+/, "");
  return trimmed === "" ? "/" : `/${trimmed.replace(/\/+$/, "")}`;
}

/* Segments of a path, without empty leading/trailing pieces. */
function segmentsOf(path: string): string[] {
  return normalizeRoutePath(path).split("/").filter((segment) => segment !== "");
}

/*
 * The template a concrete path names: the path itself when it is one of the templates, else the template whose literal segments
 * line up and whose `:param`s each fill exactly one segment. A template with no literal segment never matches (a bare-param route
 * names nothing in particular). When two same-length templates both fit, the first declared wins.
 */
export function matchRouteTemplate(path: string, templates: readonly string[]): string | undefined {
  const normalized = normalizeRoutePath(path);
  const segments = segmentsOf(normalized);
  for (const template of templates) {
    const templateSegments = segmentsOf(template);
    if (templateSegments.length !== segments.length) continue;
    if (templateSegments.every((segment) => segment.startsWith(":"))) continue;
    const fits = templateSegments.every((segment, i) => segment.startsWith(":") || segment === segments[i]);
    if (fits) return template;
  }
  return undefined;
}

export interface ExtractedReferences {
  /* `route:<template>` ids, in the order referenced. */
  routeIds: string[];
  /* `dom:<route>#…` ids, attributed to the most recent route navigation. */
  domIds: string[];
  /* `op:<operationId>` ids. */
  opIds: string[];
}

export interface ExtractReferencesInput {
  /* Delivered spec texts, in order. */
  specTexts: readonly string[];
  /* Navigation tool targets (a browser call, a run_spec hop), in order. */
  toolTargets?: readonly { tool: string; target: string | null }[];
  /* The delivered route templates, as paths without the `route:` prefix. */
  routeTemplates: readonly string[];
  /* The delivered operation ids. */
  opIds: readonly string[];
}

const GOTO = /\.?\bgoto\(\s*["'`]([^"'`]+)["'`]/g;
const TO_HAVE_URL = /\btoHaveURL\(\s*["'`]([^"'`]+)["'`]/g;
const WAIT_FOR_RESPONSE = /\bwaitForResponse\(\s*["'`]([^"'`]+)["'`]/g;
const GET_BY_TEST_ID = /\bgetByTestId\(\s*["'`]([^"'`]+)["'`]/g;
const GET_BY_ROLE = /\bgetByRole\(\s*["'`]([^"'`]+)["'`]\s*,\s*\{\s*name:\s*["'`]([^"'`]+)["'`]/g;

/* The route references of one spec text, in order, deduplicated. */
function routeRefsOf(text: string, templates: readonly string[]): string[] {
  const found: string[] = [];
  for (const pattern of [GOTO, TO_HAVE_URL, WAIT_FOR_RESPONSE]) {
    for (const match of text.matchAll(pattern)) {
      const path = normalizeRoutePath(match[1] ?? "");
      const template = matchRouteTemplate(path, templates) ?? (path === "/" ? undefined : path);
      if (template) found.push(itemId.route(template));
    }
  }
  return [...new Set(found)];
}

/* The dom references of one spec text, attributed to the most recent route navigation in the same text. */
function domRefsOf(text: string, templates: readonly string[]): string[] {
  /* The route (template) of the most recent navigation, in the order the spec text mentions things. */
  let current: string | undefined;
  const found: string[] = [];
  const re = /\.?\bgoto\(\s*["'`]([^"'`]+)["'`]|\btoHaveURL\(\s*["'`]([^"'`]+)["'`]|\bgetByTestId\(\s*["'`]([^"'`]+)["'`]|\bgetByRole\(\s*["'`]([^"'`]+)["'`]\s*,\s*\{\s*name:\s*["'`]([^"'`]+)["'`]/g;
  for (const match of text.matchAll(re)) {
    if (match[1] !== undefined || match[2] !== undefined) {
      const path = normalizeRoutePath(match[1] ?? match[2] ?? "/");
      current = matchRouteTemplate(path, templates);
    } else if (current !== undefined) {
      if (match[3] !== undefined) found.push(itemId.dom(current, match[3]));
      else if (match[4] !== undefined && match[5] !== undefined) found.push(itemId.domRole(current, match[4], match[5]));
    }
  }
  return [...new Set(found)];
}

/* The delivered operation ids a spec text names literally. */
function opRefsOf(text: string, opIds: readonly string[]): string[] {
  return opIds.filter((id) => new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)).map(itemId.op);
}

/* The route references of a navigation tool target: its URL, stripped to a path. */
function routeRefOfTarget(target: string, templates: readonly string[]): string | undefined {
  if (!target) return undefined;
  const path = target.replace(/^https?:\/\/[^/]+/, "");
  const template = matchRouteTemplate(path, templates) ?? (path === "/" ? undefined : path);
  return template ? itemId.route(template) : undefined;
}

export function extractReferences(input: ExtractReferencesInput): ExtractedReferences {
  const routeIds = new Set<string>();
  const domIds = new Set<string>();
  for (const text of input.specTexts) {
    for (const id of routeRefsOf(text, input.routeTemplates)) routeIds.add(id);
    for (const id of domRefsOf(text, input.routeTemplates)) domIds.add(id);
  }
  for (const target of input.toolTargets ?? []) {
    const id = target.target === null ? undefined : routeRefOfTarget(target.target, input.routeTemplates);
    if (id) routeIds.add(id);
  }
  const opIds = new Set<string>();
  for (const text of input.specTexts) for (const id of opRefsOf(text, input.opIds)) opIds.add(id);
  return { routeIds: [...routeIds], domIds: [...domIds], opIds: [...opIds] };
}
