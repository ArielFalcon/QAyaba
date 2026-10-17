/*
 * The stable ids of the items a grounding source supplies (docs/observability-design.md §4.4). An id is assigned where the item is
 * produced, from what the item is and nothing about the run, so the same item has the same id in every run and a grader can later
 * count which items an agent used. Pure: no clock, no randomness, no environment.
 *
 * Which kinds a spec can be checked against (§11.1) is stated here too, next to the ids, because the extraction and the id forms must
 * agree: a kind marked not extractable is reported as n/a, never as zero.
 */

import { createHash } from "node:crypto";

export const CONTEXT_SOURCES = [
  "learning",
  "curriculum",
  "context-map",
  "route-ranking",
  "dom-capture",
  "context-pack",
  "service-links",
  "structural-signal",
  "cross-repo-impact",
  "explorer-brief",
] as const;
export type ContextSource = (typeof CONTEXT_SOURCES)[number];

/* The most ids one span carries; the rest are counted. */
export const MAX_ITEM_IDS = 200; /* the registry's arrayCap for qayaba.context.item_ids says the same */
/* One id is never longer than this: a longer one keeps its head and ends with a hash of the whole, so it stays unique and stable. */
export const MAX_ITEM_ID_CHARS = 200;

export const ID_KIND = ["route", "dom", "op", "link", "flow", "rule", "exemplar", "brief", "fact", "signal", "svc-link", "impact"] as const;
export type IdKind = (typeof ID_KIND)[number];

/* Whether a spec's text can be checked against ids of this kind. Brief claim hashes are not stable across runs, and exemplar tags in a manifest are the agent's own report. */
export const ID_KIND_EXTRACTABLE: Readonly<Record<IdKind, boolean>> = {
  route: true,
  dom: true,
  op: true,
  link: false,
  flow: false,
  rule: false,
  exemplar: false,
  brief: false,
  fact: false,
  signal: false,
  "svc-link": false,
  impact: false,
};

/* The first eight hex digits of the sha256 of the text with its whitespace collapsed and its case folded. */
export function hash8(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

/* An id never holds a line break or another control character, and is bounded. */
function clean(text: string): string {
  const flat = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
  if (flat.length <= MAX_ITEM_ID_CHARS) return flat;
  const digest = createHash("sha256").update(flat).digest("hex").slice(0, 8);
  return `${flat.slice(0, MAX_ITEM_ID_CHARS - 9)}~${digest}`;
}

export const itemId = {
  route: (templatePath: string): string => clean(`route:${templatePath}`),
  op: (operationId: string): string => clean(`op:${operationId}`),
  link: (route: string, operationId: string): string => clean(`link:${route}→${operationId}`),
  flow: (id: string): string => clean(`flow:${id}`),
  rule: (ruleId: string): string => clean(`rule:${ruleId}`),
  exemplar: (id: string): string => clean(`exemplar:${id}`),
  dom: (route: string, testId: string): string => clean(`dom:${route}#${testId}`),
  domRole: (route: string, role: string, accessibleName: string): string => clean(`dom:${route}#role:${role}:${hash8(accessibleName)}`),
  fact: (route: string, testId: string, state: "present" | "absent"): string => clean(`fact:${route}#${testId}:${state}`),
  brief: (kind: string, claim: string): string => clean(`brief:${kind}:${hash8(claim)}`),
  signal: (line: string): string => `signal:${hash8(line)}`,
  svcLink: (link: ServiceLinkLike): string => clean(`svc-link:${link.from.repo}/${link.from.symbol}→${link.to.repo}/${link.to.symbol}`),
  impact: (tier: string, link: ServiceLinkLike): string => clean(`impact:${tier}:${link.from.repo}/${link.from.symbol}→${link.to.repo}/${link.to.symbol}`),
};

export interface ServiceLinkLike {
  from: { repo: string; symbol: string };
  to: { repo: string; symbol: string };
}

/* The ids without repeats, in the order they were produced, cut to the cap with the overflow counted. */
export function capItemIds(ids: readonly string[], max: number = MAX_ITEM_IDS): { ids: string[]; overflow: number } {
  const unique = [...new Set(ids)];
  return { ids: unique.slice(0, max), overflow: Math.max(0, unique.length - max) };
}

/* ---- per source ---- */

export interface MapLike {
  routes: ReadonlyArray<{ path: string }>;
  api: ReadonlyArray<{ operationId: string }>;
  feBe: ReadonlyArray<{ route: string; operationId: string }>;
  flows?: ReadonlyArray<{ id: string }>;
}

/* Routes, operations, FE-to-BE links and flows of the architecture map, in the map's own order. */
export function contextMapItemIds(map: MapLike): string[] {
  return [
    ...map.routes.map((r) => itemId.route(r.path)),
    ...map.api.map((o) => itemId.op(o.operationId)),
    ...map.feBe.map((l) => itemId.link(l.route, l.operationId)),
    ...(map.flows ?? []).map((f) => itemId.flow(f.id)),
  ];
}

export interface DomPageLike {
  route: string;
  /* The accessibility-tree lines the capture rendered: `role: name`. */
  nodes?: readonly string[];
  /* node line (state suffix stripped) to the test id it carries. */
  testIdOfNode?: ReadonlyMap<string, string>;
  /* Every test id on the page. */
  testIds?: Iterable<string>;
}

/* A test id names its element; a node without one is named by its role and a hash of its accessible name. */
export function domItemIds(pages: readonly DomPageLike[]): string[] {
  const ids: string[] = [];
  for (const page of pages) {
    for (const testId of page.testIds ?? []) ids.push(itemId.dom(page.route, testId));
    for (const node of page.nodes ?? []) {
      if (node.startsWith("text:") || page.testIdOfNode?.has(node)) continue;
      const colon = node.indexOf(": ");
      if (colon <= 0) continue;
      const role = node.slice(0, colon);
      const name = node.slice(colon + 2).replace(/\s*\[[^\]]*\]\s*$/, "");
      if (name === "(present)") continue;
      ids.push(itemId.domRole(page.route, role, name));
    }
  }
  return ids;
}

/* For each test id a change added: present on every captured route that shows it, and absent (route `*`) when no captured route shows it. */
export function changedValueFactIds(pages: ReadonlyArray<{ route: string; testIds?: Iterable<string> }>, changedTestIds: readonly string[]): string[] {
  const ids: string[] = [];
  const shown = pages.map((p) => ({ route: p.route, set: new Set(p.testIds ?? []) }));
  for (const testId of [...new Set(changedTestIds)]) {
    const where = shown.filter((p) => p.set.has(testId));
    if (where.length === 0) ids.push(itemId.fact("*", testId, "absent"));
    else for (const p of where) ids.push(itemId.fact(p.route, testId, "present"));
  }
  return ids;
}

/* The fewest ids a route keeps when the span's budget is shared out among the routes of a capture. */
export const MIN_DOM_IDS_PER_ROUTE = 5;

/* The same ids, with the span's budget shared out evenly among the pages (at least a few each) so that the last pages of a capture are not the ones that fall off the cap. What a page's share leaves out is counted for it, keyed by the page's route. */
export function domItemIdsBudgeted(pages: readonly DomPageLike[], total: number = MAX_ITEM_IDS): { ids: string[]; overflowByRoute: Map<string, number> } {
  const share = Math.max(MIN_DOM_IDS_PER_ROUTE, Math.floor(total / Math.max(1, pages.length)));
  const ids: string[] = [];
  const overflowByRoute = new Map<string, number>();
  for (const page of pages) {
    const own = [...new Set(domItemIds([page]))];
    ids.push(...own.slice(0, share));
    if (own.length > share) overflowByRoute.set(page.route, (overflowByRoute.get(page.route) ?? 0) + own.length - share);
  }
  return { ids, overflowByRoute };
}

export interface BriefLike {
  routes?: ReadonlyArray<{ path: string }>;
  feBe?: ReadonlyArray<{ route: string; operationId: string; via?: string }>;
  contracts?: ReadonlyArray<{ operationId: string; method: string; path: string }>;
  risks?: readonly string[];
  blastRadius?: ReadonlyArray<{ symbol: string; file: string; role: string }>;
}

/* One id per claim of the explorer's brief: its kind and a hash of the normalized claim. Recorded, but not extractable. */
export function briefItemIds(brief: BriefLike): string[] {
  return [
    ...(brief.blastRadius ?? []).map((n) => itemId.brief("blast", `${n.file} ${n.symbol} ${n.role}`)),
    ...(brief.routes ?? []).map((r) => itemId.brief("route", r.path)),
    ...(brief.feBe ?? []).map((l) => itemId.brief("fe-be", `${l.route} ${l.operationId}`)),
    ...(brief.contracts ?? []).map((c) => itemId.brief("contract", `${c.method} ${c.path} ${c.operationId}`)),
    ...(brief.risks ?? []).map((r) => itemId.brief("risk", r)),
  ];
}

/* One id per content line of an advisory block (a heading is not an item). */
export function advisoryLineIds(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => itemId.signal(line));
}
