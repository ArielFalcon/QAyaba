/* Deterministic pre-generation context pack (DOM + contracts). Read-only on watched repos. Every component is fail-open: a failed piece yields an absent section, never a crashed run. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { sanitizeText } from "../../../shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { captureDomForRoutes, defaultCaptureDomDeps, MAX_ROUTES, MAX_ROUTES_PER_CHANGE, REDIRECT_ADVISORY_INTRO } from "./dom-snapshot.ts";
import type { CapturedPage, CaptureDomDeps, CaptureRoutesInput, PageDelivery } from "./dom-snapshot.ts";
import { loggableRoutes } from "./loggable-route.ts";
import type { ArchitectureContext, ApiOperation } from "../domain/generation-input.ts";
import type { ChangedElement } from "../../../shared-kernel/diff-parser/changed-element.ts";
import { classifyRoutes, ROUTE_REASON } from "../../../shared-kernel/route-capturability.ts";
import { claim, type FactId, type PromptClaim } from "../domain/prompt-contract-lint.ts";
import { PACK_HEADINGS } from "../domain/prompt-headings.ts";
import { rankRoutesWithRelevance, type ChangePageBasis, type RankedRoute } from "../domain/route-ranking.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { instantiableTemplate, instantiateRoute, isPageOfTemplate, missingSibling } from "../domain/route-instantiation.ts";
import { changedValueFactIds, domItemIds, itemId } from "../../../shared-kernel/context-item-ids.ts";
import type { Omission } from "@kernel/telemetry/section-meta.ts";
import { renderChangedValues, valuesWithMoreNodesThanLines, type ObservedPage } from "../domain/changed-values.ts";
import type { ChangedLiteral } from "../../../shared-kernel/diff-parser/changed-literal.ts";
import type { RouteAvailabilityFact } from "@kernel/route-availability.ts";
import { classifyPackAvailability, type PackAvailabilityInput } from "./pack-availability.ts";
import { availabilitySectionLines } from "../domain/route-availability-section.ts";
import { requestsSectionLines, REQUESTS_SECTION_INTRO } from "../domain/pack-requests.ts";
import { contradictionsSectionLines, CONTRADICTIONS_SECTION_INTRO } from "../domain/pack-contradictions.ts";
import { findDataContradictions, type ResponseFieldsOf } from "../domain/data-contradictions.ts";
import type { DataContradiction } from "@kernel/data-contradiction.ts";
export { PACK_HEADINGS };

const SECTION_FACTS: ReadonlyArray<readonly [string, FactId]> = [
  [PACK_HEADINGS.liveDom, "dom-live"],
  [PACK_HEADINGS.changedValues, "changed-values"],
  [PACK_HEADINGS.contracts, "api-operations"],
];

const escapeRegExp = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* The pack reaches the prompt as an already-built string, so its claims come from the sections it actually rendered: a pack with only a DOM provides only the DOM. The live DOM's own heading labels it ground truth, so that is the one fact the pack frames. */
export function deriveClaimsFromPackText(text: string): PromptClaim[] {
  const claims: PromptClaim[] = [];
  for (const [heading, fact] of SECTION_FACTS) {
    if (!new RegExp(`^### ${escapeRegExp(heading)}`, "m").test(text)) continue;
    claims.push(claim.provides(fact));
    if (fact === "dom-live") claims.push(claim.frames(fact, "established"));
  }
  return claims;
}


export interface ContextPackInput {
  baseUrl?: string;

  e2eDir?: string;

  contextMap?: ArchitectureContext;

  prChangedFiles?: string[];

  /* Diff/guidance selector signals forwarded to formatDomSnapshot for [CHANGED: …] annotation. Absent/empty → no annotation. */
  changedElements?: ChangedElement[];

  /* The quoted labels the diff added and removed, each with how many unchanged lines of its file already hold it when that file was read. The pack states, for each, how many nodes of the captured trees show it. Absent/empty → no section. */
  changedLiterals?: ChangedLiteral[];

  /* Selector grounding: the config-declared test-id convention (e.g. "data-cy"), forwarded to captureDomForRoutes so the DOM capture queries the right attribute and the agent transcribes real test-ids instead of guessing. Absent → capture defaults to "data-testid". */
  testIdAttribute?: string;

  /* The routes the orchestrator derived from the architecture map; the pack ranks them by the change and captures the top of the ranking. */
  routes?: string[];

  /* Cross-repo runs only: where the triggering service's snapshot was staged, as the map may name it. Present (even empty) means prChangedFiles are the service's own files, so a route is ranked only by the spec of an operation it joins, under these roots. */
  stagedRoots?: string[];

  /* The use cases the change makes testable; their pages rank after the pages the map links, by tier (route ranking). Absent → the map's links alone. */
  candidates?: readonly UseCaseCandidate[];

  /* Pages a hub of the change reaches; they rank after every change page and before the rest, and are never change pages (route ranking). */
  hubPages?: string[];

  /* false → no live-DOM capture, no route ranking, no redirect advisory, no "not capturable" list (an A/B arm; default true). Contracts and the pack header stay. */
  domPack?: boolean;

  /* Classify why a captured route was not available at its own address. Absent → no classification and no availability section. */
  availability?: PackAvailabilityInput;

  /* The fields the app's OpenAPI documents declare for the items an operation returns: what backs a possible data contradiction. Absent → no fact is backed by a schema and none is removed by one. */
  responseFields?: ResponseFieldsOf;
}

/* What the pack was made from, for the trace: nothing here reaches the agent or the verdict. */
export interface ContextPackTrace {
  /* The routes asked of the capture, in rank order, after the cut. */
  rankedRoutes: string[];
  /* The routes the change actually links to, as map templates; empty when nothing was linked. */
  relevantRoutes?: string[];
  /* The component/page each relevant route belongs to, parallel to `relevantRoutes`. */
  relevantGroups?: string[];
  /* Why each relevant route is one (the map's link or the graph's proof), parallel to `relevantRoutes`. */
  relevantBasis?: ChangePageBasis[];
  /* The routes that name a page, before the cut. */
  capturablePages: number;
  /* The pages the capture returned. */
  pages: CapturedPage[];
  /* Each captured page as it delivered: kept nodes/test ids and the node→test-id map. */
  pageDeliveries: PageDelivery[];
  /* The test ids the change added (ChangedElement), for the present or absent fact of each. */
  changedTestIds: string[];
  /* The operations whose contracts the pack carries. */
  contractIds: string[];
  /* DOM nodes the per-page safety bound left out, over every page (0 unless a page passed MAX_NODES_PER_PAGE). */
  omittedLines: number;
}

/* The pack's grounding ids: the DOM ids per page, the change-value facts and the contracts, with what the per-page node safety bound left out. The pack holds every page whole, so what it delivers is what it produced; what a prompt shows of it is the window's to decide, and the prompt records what its window left out. */
function packItemIds(assembly: ContextPackAssembly): { ids: string[]; omissions: Omission[] } {
  const trace = assembly.trace;
  if (!trace) return { ids: [], omissions: [] };
  const deliveries = trace.pageDeliveries ?? [];
  const domIds = domItemIds(deliveries.map((p) => ({ route: p.route, nodes: p.keptNodes, testIdOfNode: p.testIdOfNode, testIds: p.keptTestIds })));
  const factIds = changedValueFactIds(trace.pages.map((page) => ({ route: page.template ?? page.route, ...(page.testIds ? { testIds: page.testIds } : {}), unconfirmed: page.dataStateUnconfirmed === true })), trace.changedTestIds);
  const opIds = trace.contractIds.map(itemId.op);
  const omissions: Omission[] = [];
  for (const p of deliveries) {
    if (p.nodeCapOmitted > 0) omissions.push({ class: "truncation", reason: NODE_SAFETY_BOUND_REASON, count: p.nodeCapOmitted, route: p.route });
  }
  return { ids: [...domIds, ...factIds, ...opIds], omissions };
}

/* The omission reason of the per-page node safety bound (MAX_NODES_PER_PAGE). */
export const NODE_SAFETY_BOUND_REASON = "node-safety-bound";

/* What the pack produced: every page's nodes and test ids within the node safety bound. */
export function packProducedItemIds(assembly: ContextPackAssembly): { ids: string[]; omissions: Omission[] } {
  return packItemIds(assembly);
}

/* What the pack delivered to the prompts: the same as what it produced, since no line count cuts the pack. */
export function packDeliveredItemIds(assembly: ContextPackAssembly): { ids: string[]; omissions: Omission[] } {
  return packItemIds(assembly);
}

export interface ContextPackAssembly {
  text: string | undefined;

  domBytes: number;
  contractBytes: number;
  trace?: ContextPackTrace;
  /* The added values whose changed-value line states more nodes on a route than unchanged lines hold them. Absent when none does. */
  changedValuesWithMoreNodes?: string[];
  /* Why each captured route that was not available at its own address was not, and how many routes the capture read. Absent when the pack did not classify. */
  routeAvailability?: { read: number; facts: RouteAvailabilityFact[] };
  /* The data sources of one page that disagree on what their items carry, and how many pages had a response shape to read. Absent when no page did. */
  dataContradictions?: { read: number; facts: DataContradiction[] };
}

/* mutation-scope:begin context-pack-deps */
export interface ContextPackDeps {
  captureDomForRoutes(
    routes: string[],
    input: CaptureRoutesInput,
    domDeps: CaptureDomDeps,
    changed?: ChangedElement[],
  ): Promise<string | undefined>;
  domDeps: CaptureDomDeps;
  /* The app's declared page per route template (dev.routeSamples): opened when no link the site showed fits the template, for an app that navigates without links. App data, never inferred. */
  routeSamples?: Readonly<Record<string, string>>;
  /* `how` marks a line that explains how the capture went and no span records: it is shipped to the log store (docs/observability-design.md, log roles). */
  log?: (msg: string, how?: { ship: true }) => void;
}


export const defaultContextPackDeps: ContextPackDeps = {
  captureDomForRoutes,
  domDeps: defaultCaptureDomDeps,
  log: (msg, how) => engineLog.info(msg, how),
};


/* mutation-scope:end context-pack-deps */

function filterRelevantContracts(
  contextMap: ArchitectureContext | undefined,
  prChangedFiles: string[] | undefined,
): ApiOperation[] {
  if (!contextMap || !contextMap.api?.length) return [];

  const relevantIds = new Set<string>();

  if (prChangedFiles?.length && contextMap.feBe?.length) {
    for (const link of contextMap.feBe) {
      const terms = [link.route, link.via ?? "", link.operationId].filter((t) => t && t.length >= 3);
      if (prChangedFiles.some((f) => terms.some((t) => f.includes(t)))) {
        relevantIds.add(link.operationId);
      }
    }
  }

  if (relevantIds.size === 0) return [];
  return contextMap.api.filter((op) => relevantIds.has(op.operationId));
}


/* mutation-scope:begin contract-sanitizer */
const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;

/* The most routes the pack lists as not capturable: a long list says no more than its first lines. */
export const MAX_LISTED_UNCAPTURABLE = 8;

/* A route the pack did not capture, with why. */
interface NotCaptured {
  route: string;
  reason: string;
}

/* Why a template of the map that was meant to be captured is not. */
export const TEMPLATE_LEFT_OUT = {
/* mutation-scope:end contract-sanitizer */
  /* The pages that could show a link to it were captured, and none did. */
  NO_LINK: `${ROUTE_REASON.TEMPLATE}: no link to a page of it was seen`,
  /* No page that could show a link to it was captured, so whether the site links to it is not known. */
  NO_PAGE_TO_LOOK_AT: `${ROUTE_REASON.TEMPLATE}: no page that could show a link to it was captured`,
  /* A link to a page of it was seen, but that page was not captured at its own address. */
  PAGE_NOT_CONFIRMED: `${ROUTE_REASON.TEMPLATE}: the page found for it could not be captured at its own address`,
  /* The page the app declares for it (dev.routeSamples) shows what a page of it that cannot exist shows: the declared page is gone. */
  DECLARED_PAGE_MISSING: `${ROUTE_REASON.TEMPLATE}: the page declared for it shows what a page that does not exist shows`,
  /* The capture's page count was spent on routes that rank ahead of it, so it was never looked at: not a page the capture failed on. */
  BEHIND_THE_CUT: `${ROUTE_REASON.TEMPLATE}: behind the capture's page count, never looked at`,
} as const;

/* How alike a declared page's tree and its missing sibling's must be, as the share of their node lines in common, for the declared page to be read as missing. */
const MISSING_PAGE_LIKENESS = 0.9;

function likeness(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  const union = new Set([...left, ...right]).size;
  if (union === 0) return 1;
  let shared = 0;
  for (const node of left) if (right.has(node)) shared++;
  return shared / union;
}

/* The routes left out of the capture because they name no single page, or no page of them was found, each with why. They are not degraded pages: nothing was captured for them. */
function renderNotCapturable(routes: readonly NotCaptured[]): string {
  if (routes.length === 0) return "";
  const listed = routes.slice(0, MAX_LISTED_UNCAPTURABLE).map((entry) => `- ${s(entry.route)} (${entry.reason})`);
  const more = routes.length - listed.length;
  /* mutation-scope:begin not-capturable-listing */
  return [`### ${PACK_HEADINGS.notCapturable}`, ...listed, ...(more > 0 ? [`(+${more} more)`] : [])].join("\n");
}

function renderContracts(ops: ApiOperation[]): string {
  if (!ops.length) return "";
  const lines: string[] = [`### ${PACK_HEADINGS.contracts} (from context.json — assert these at the boundary)`];
  for (const op of ops) {
    lines.push(`- \`${s(op.operationId)}\`: ${s(op.method)} ${s(op.path)}${op.service ? ` (${s(op.service)})` : ""}`);
  }
  return lines.join("\n");
}


/* The pack without one of its sections, for a caller that supplies that content fresher elsewhere. `undefined` when no section remains: a header with nothing under it is no pack. */
export function withoutPackSection(text: string, heading: string): string | undefined {
  const start = new RegExp(`^### ${escapeRegExp(heading)}`);
  const kept: string[] = [];
  let skipping = false;
  let removed = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("### ")) skipping = start.test(line);
    if (skipping) removed = true;
    else kept.push(line);
  }
  if (!removed) return text;
  if (!kept.some((line) => line.startsWith("### "))) return undefined;
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  /* mutation-scope:end not-capturable-listing */
/* mutation-scope:begin pack-section-gap */
}

/* mutation-scope:end pack-section-gap */
/* mutation-scope:begin pack-sections-assembly */
interface PackSection {
  text: string;
  /* How the pack's header names the section. */
  held: string;
}

const hasText = (section: PackSection): boolean => section.text.length > 0;

/* The capture reports the grounded routes and, after them, the pages redirects reached under a heading of their own; the live DOM section takes the first and the pack keeps the second as a section apart. */
function splitRedirectSection(captured: string): { grounded: string; advisory: string } {
  const [grounded = "", ...advisory] = captured.split(new RegExp(`^(?=### ${escapeRegExp(PACK_HEADINGS.redirected)})`, "m"));
  return { grounded: grounded.trimEnd(), advisory: advisory.join("").trimEnd() };
}

/* mutation-scope:end pack-sections-assembly */
/* The pages redirects reached in two captures, as the one section they are: the first's heading and introduction, then the pages of both. */
function joinRedirectSections(first: string, second: string): string {
  if (first === "" || second === "") return first || second;
  const at = second.indexOf(REDIRECT_ADVISORY_INTRO);
  const pages = at === -1 ? second : second.slice(at + REDIRECT_ADVISORY_INTRO.length).replace(/^\n/, "");
  return `${first}\n${pages}`;
}

/* One capture of the pack, split into the live DOM it grounds and the redirect section. */
interface PackCapture {
  grounded: string;
  advisory: string;
}

/* The address a capture-state line names: the page's own final pathname when the browser reported a different one, else its route (marked as a template instance as the report does). */
function captureStateLabel(page: CapturedPage): string {
  let finalPath: string | undefined;
  if (page.finalUrl !== undefined) {
    try { finalPath = new URL(page.finalUrl).pathname; } catch { finalPath = page.finalUrl; }
  }
  if (finalPath !== undefined && finalPath !== page.route) return finalPath;
  return page.template !== undefined ? `${page.route} (instance of ${page.template})` : page.route;
}

/* One "Capture state" line for a page whose dev.dataState route matched: its result count, effective location and, when the state could not be confirmed, the explicit warning that an empty tree is not proof. */
/* mutation-scope:begin capture-state-line */
function captureStateLine(page: CapturedPage, hasChangedElements: boolean): string {
  const parts: string[] = [];
  if (page.resultCount !== undefined) parts.push(`${page.resultCount} result(s)`);
  if (page.emptyConfirmed === true) parts.push("empty state confirmed (0 read on two reads of a settled page): the page has no results now");
  if (page.effectiveLocation !== undefined) parts.push(`location "${s(page.effectiveLocation)}"`);
  if (page.captureAttempts !== undefined && page.captureAttempts > 1) parts.push("captured twice");
  if (page.dataStateUnconfirmed === true) {
    parts.push(`data state not confirmed — ${hasChangedElements ? "the changed element is unobservable now" : "the page's data state is unconfirmed"}; do not assert an empty state as truth; a reasoned no-op is admissible.`);
  }
  return parts.length > 0 ? `- ${s(captureStateLabel(page))}: ${parts.join(", ")}` : "";
}

/* mutation-scope:end capture-state-line */
export async function buildContextPack(
  input: ContextPackInput,
  deps: ContextPackDeps,
): Promise<ContextPackAssembly> {
  const log = deps.log ?? (() => {});
  const domPack = input.domPack !== false;
  if (!domPack) log("context-pack: DOM capture skipped (grounding.domPack off) — no live DOM");

  let domSection = "";
  let redirectSection = "";
  /* The derived routes are ranked by the change. With no changed file there is nothing to rank by. */
  const derivedRoutes = [...new Set(input.routes ?? [])];
  const ranked: RankedRoute[] = input.prChangedFiles
    ? rankRoutesWithRelevance(derivedRoutes, input.contextMap, { changedFiles: input.prChangedFiles, ...(input.stagedRoots ? { stagedRoots: input.stagedRoots } : {}), ...(input.candidates?.length ? { candidates: input.candidates } : {}), ...(input.hubPages?.length ? { hubPages: input.hubPages } : {}) })
    : derivedRoutes.map((route) => ({ route, rank: 0, relevant: false, files: [] }));
  const deterministicRoutes = ranked.map((entry) => entry.route);
  const relevantRanked = ranked.flatMap((entry) => (entry.relevant && entry.basis !== undefined ? [{ route: entry.route, basis: entry.basis }] : []));
  const relevantMapRoutes = relevantRanked.map((entry) => entry.route);
  const relevantBasis = relevantRanked.map((entry) => entry.basis);
  const componentOf = new Map((input.contextMap?.routes ?? []).map((route) => [route.path, route.component ?? route.path]));
  /* A route named twice is counted once, and a route that names no page and no template of one is dropped, BEFORE the cut: neither may take the slot of a route behind it. A template stays in its place: it opens to a page through a link the site shows, and the cut is made on the pages, not on the templates. */
  const classified = classifyRoutes(deterministicRoutes);
  /* Only a route made of literals and whole-segment parameters can be filled from a link; any other route that names no page is simply left out. */
  const isTemplate = (entry: { route: string }): boolean => instantiableTemplate(entry.route);
  /* The cut: a change linked to more pages than the default cut has each of them captured, up to the per-change bound. */
  const routeCap = Math.min(MAX_ROUTES_PER_CHANGE, Math.max(MAX_ROUTES, relevantMapRoutes.length));
  /* The pages the first capture renders: the routes that are pages, as many as the cut keeps. */
  const capturablePages = classified.filter((entry) => entry.reason === undefined).length;
  const firstPass = classified.filter((entry) => entry.reason === undefined).map((entry) => entry.route).slice(0, routeCap);
  /* A template can take a slot only if fewer than a cut's worth of pages rank ahead of it. */
  const reachableTemplates: string[] = [];
  let pagesAhead = 0;
  for (const entry of classified) {
    if (entry.reason === undefined) pagesAhead++;
    else if (isTemplate(entry) && pagesAhead < routeCap) reachableTemplates.push(entry.route);
  }
  const reachable = reachableTemplates.length > 0;
  const pages = new Map<string, CapturedPage>();
  const deliveries = new Map<string, PageDelivery>();
  const captures: PackCapture[] = [];
  let renderedRoutes = 0;
  /* The routes the report covers: a page rendered only for its links is no part of it. */
  const reportedRoutes = new Set<string>();
  const capture = async (routes: string[], captureInput: CaptureRoutesInput): Promise<void> => {
    const rawCaptured = await deps.captureDomForRoutes(routes, { ...captureInput, onPages: (reported) => { for (const page of reported) { pages.set(page.route, page); deliveries.set(page.route, { route: page.template ?? page.route, ...(page.template !== undefined ? { template: page.template } : {}), keptNodes: page.keptNodes ?? [], keptTestIds: page.keptTestIds ?? [], testIdOfNode: page.testIdOfNode ?? new Map(), nodeCapOmitted: page.nodeCapOmitted ?? 0 }); } } }, deps.domDeps, input.changedElements);
    const raw = rawCaptured ? sanitizeText(rawCaptured, "model").text : rawCaptured;
    if (!raw) return;
    const { grounded, advisory } = splitRedirectSection(raw);
    captures.push({ grounded, advisory });
    renderedRoutes += routes.length;
    for (const route of routes) reportedRoutes.add(route);
  };
  /* What became of each template the run looked at: the page the links gave it, if any. A template behind the cut is never looked at. */
  const instanceOfTemplate = new Map<string, string | undefined>();
  /* The declared pages that showed what their missing sibling shows: never delivered as a page of their template. */
  const declaredMissing = new Set<string>();
  /* Each declared page is rendered beside its sibling that cannot exist; one whose tree is that sibling's is the site's "nothing here" page, not a page of the template. A render that fails or reports either page not grounded settles nothing, and the declared page is kept. A declared page that render did not ground is not opened again: the capture would spend the same wait on it. */
  const checkDeclaredPages = async (declared: ReadonlyMap<string, string>, base: CaptureRoutesInput): Promise<{ missing: string[]; ungrounded: string[] }> => {
    const pairs = [...declared]
      .flatMap(([page, template]) => {
        const sibling = missingSibling(template, page);
        return sibling === undefined ? [] : [{ page, template, sibling }];
      })
      .slice(0, Math.floor(MAX_ROUTES / 2));
    if (pairs.length === 0) return { missing: [], ungrounded: [] };
    const seen = new Map<string, CapturedPage>();
    try {
      await deps.captureDomForRoutes(pairs.flatMap((pair) => [pair.page, pair.sibling]), { ...base, onPages: (reported) => { for (const page of reported) seen.set(page.route, page); } }, deps.domDeps);
    } catch (err) {
      log(`[qa] context-pack: DOM capture of the declared template pages beside their missing siblings FAILED (${err instanceof Error ? err.message : String(err)}) — the declared pages are kept unchecked`, { ship: true });
      return { missing: [], ungrounded: [] };
    }
    const missing = pairs
      .filter(({ page, sibling }) => {
        const shown = seen.get(page);
        const missing = seen.get(sibling);
        return shown?.grounded === true && missing?.grounded === true && likeness(shown.nodes ?? [], missing.nodes ?? []) >= MISSING_PAGE_LIKENESS;
      })
      .map(({ page }) => page);
    const ungrounded = pairs.filter(({ page }) => seen.get(page)?.grounded !== true).map(({ page }) => page);
    return { missing, ungrounded };
  };
  if (domPack && (firstPass.length > 0 || reachable) && input.e2eDir && input.baseUrl) {
    const base = { e2eDir: input.e2eDir, baseUrl: input.baseUrl, testIdAttribute: input.testIdAttribute, maxRoutes: routeCap };
    try {
      /* The first capture is of the routes that are pages. When a template can still take a slot it also reports the links its pages show, and renders the app root for them when the root is no route asked for: the template cannot be opened, but a link to a page of it can. */
      await capture(firstPass, reachable && !firstPass.includes("/") ? { ...base, linkSeeds: ["/"] } : base);
      const links = [...new Set([...pages.values()].flatMap((page) => page.links))];
      /* The cut, made on pages in rank order: a route that is a page, or the page the links give a template. The first capture's pages are rendered already and stay in the pack even when the cut leaves them out. */
      const cut = new Set<string>();
      const instances = new Map<string, string>();
      /* The pages taken from dev.routeSamples because no link fit their template: what the site showed is live, a declared page may be gone. */
      const declaredInstances = new Map<string, string>();
      for (const entry of classified) {
        if (cut.size >= routeCap) break;
        /* A route that is a page and comes up before the cut is full is one of the first capture's: fewer than a cut's worth of pages came before it. */
        if (entry.reason === undefined) {
          cut.add(entry.route);
        } else if (isTemplate(entry)) {
          const linked = instantiateRoute(entry.route, links);
          const declared = deps.routeSamples?.[entry.route];
          const instance = linked ?? (declared !== undefined && isPageOfTemplate(entry.route, declared) ? declared : undefined);
          instanceOfTemplate.set(entry.route, instance);
          if (instance === undefined) continue;
          cut.add(instance);
          if (!firstPass.includes(instance) && !instances.has(instance)) {
            instances.set(instance, entry.route);
            if (linked === undefined) declaredInstances.set(instance, entry.route);
          }
        }
      }
      const checked = await checkDeclaredPages(declaredInstances, base);
      for (const page of checked.missing) {
        instances.delete(page);
        declaredMissing.add(page);
      }
      for (const page of checked.ungrounded) instances.delete(page);
      if (instances.size > 0) {
        try {
          await capture([...instances.keys()], { ...base, instanceOf: instances });
        } catch (err) {
          log(`[qa] context-pack: DOM capture of the pages found for route templates FAILED (${err instanceof Error ? err.message : String(err)}) — those templates are not grounded`, { ship: true });
        }
      }
      if (captures.length > 0) {
        /* Every page whole: no line count cuts the live DOM. A prompt that cannot hold a page shows it as a reference by its role's window. */
        /* mutation-scope:begin grounded-line-route-header */
        const grounded = captures.map((c) => c.grounded).filter((text) => text !== "").join("\n");
        /* mutation-scope:end grounded-line-route-header */
        /* mutation-scope:begin grounded-line-routes */
        const lineCount = grounded === "" ? 0 : grounded.split("\n").length;
        /* mutation-scope:end grounded-line-routes */
        redirectSection = captures.map((c) => c.advisory).reduce(joinRedirectSections, "");
        /* An explicit capture-state line per page whose dev.dataState route matched, so an unconfirmed (empty) tree is not read as truth. */
        const statePages = [...pages.values()].filter((page) => page.dataState === true).slice(0, MAX_ROUTES + 1);
        const hasChangedElements = (input.changedElements?.length ?? 0) > 0;
        const captureStateLines = statePages.map((page) => captureStateLine(page, hasChangedElements)).filter((line) => line !== "");
        const captureStateIntro = statePages.some((page) => page.dataStateUnconfirmed === true)
          ? "An unconfirmed capture state below means an element's absence in this tree is not proof it is absent on the page."
          : "";
        domSection = [
          `### ${PACK_HEADINGS.liveDom} (a11y tree — GROUND TRUTH for selectors)`,
          "These roles + accessible names are what the browser ACTUALLY exposes.",
          "Author selectors ONLY from what appears here — if a role is absent, it is NOT in the tree.",
          "A name a page shows more than once carries `(N on this page with this name; in a < b)`: the containers, nearest first, that only that occurrence is in, each written as a locator names it (`[test-id=\"…\"]`, `#id`, a custom element's tag).",
          "A route line `(the changed text \"…\" is in X in the source; this page shows no X now)` means the changed element is not on that page as DEV renders it now.",
          ...(captureStateIntro ? [captureStateIntro] : []),
          ...captureStateLines,
          grounded,
        ].join("\n");
        log(`[qa] context-pack: DOM captured ${lineCount} lines for ${renderedRoutes} route(s)`);
      } else {
        log(`[qa] context-pack: DOM capture returned nothing for routes [${loggableRoutes(firstPass)}] — grounding skipped`, { ship: true });
      }
    } catch (err) {
      log(`[qa] context-pack: DOM capture FAILED (${err instanceof Error ? err.message : String(err)}) — grounding skipped`, { ship: true });
      /* The links were never read: a template that was to be opened through them is unopened for that reason. */
      for (const template of reachableTemplates) instanceOfTemplate.set(template, undefined);
    }
  }
  /* What is left out: every route that names no single page, and the templates no grounded page was found for. A template is opened only when the page the links gave it was captured with content at its own address; a page that was not reported at all (a capture that failed, timed out or was unreadable) is not grounded. */
  const grounded = (route: string): boolean => pages.get(route)?.grounded === true;
  const anyPageGrounded = [...pages.values()].some((page) => page.grounded);
  const reasonFor = (entry: { route: string; reason?: string }): string | undefined => {
    if (!isTemplate(entry)) return entry.reason;
    if (!instanceOfTemplate.has(entry.route)) return captures.length > 0 && !reachableTemplates.includes(entry.route) ? TEMPLATE_LEFT_OUT.BEHIND_THE_CUT : entry.reason;
    const instance = instanceOfTemplate.get(entry.route);
    if (instance === undefined) return anyPageGrounded ? TEMPLATE_LEFT_OUT.NO_LINK : TEMPLATE_LEFT_OUT.NO_PAGE_TO_LOOK_AT;
    if (declaredMissing.has(instance)) return TEMPLATE_LEFT_OUT.DECLARED_PAGE_MISSING;
    return grounded(instance) ? undefined : TEMPLATE_LEFT_OUT.PAGE_NOT_CONFIRMED;
  };
  const notCaptured: NotCaptured[] = domPack
    ? classified.flatMap((entry) => {
        const reason = reasonFor(entry);
        return reason === undefined ? [] : [{ route: entry.route, reason }];
      })
    : [];
  if (notCaptured.length > 0) {
    /* One line for the whole set, grouped by why: how the capture fell short has no home in a span, and a line per route is noise. */
    const byReason = new Map<string, string[]>();
    for (const entry of notCaptured) byReason.set(entry.reason, [...(byReason.get(entry.reason) ?? []), entry.route]);
    const groups = [...byReason].map(([reason, routes]) => `${reason}: ${loggableRoutes(routes)}`);
    log(`[qa] context-pack: ${notCaptured.length} route(s) not capturable, left out of the capture (${groups.join("; ")})`, { ship: true });
  }

  let contractSection = "";
  const relevantOps = filterRelevantContracts(input.contextMap, input.prChangedFiles);
  if (relevantOps.length > 0) {
    contractSection = renderContracts(relevantOps);
    log(`[qa] context-pack: ${relevantOps.length} relevant API contract(s) included`);
  }

  /* What the grounded pages of the report say of the labels the change added and removed: nothing without a captured DOM to count in. */
  const observedPages: ObservedPage[] = [...pages.values()]
    .filter((page) => page.grounded && reportedRoutes.has(page.route))
    .map((page) => ({ route: page.route, nodes: page.nodes ?? [] }));
  const changedValuesSection =
    domSection !== "" && input.changedLiterals?.length ? sanitizeText(renderChangedValues(input.changedLiterals, observedPages), "model").text : "";

  const moreNodes = changedValuesSection === "" ? [] : valuesWithMoreNodesThanLines(input.changedLiterals ?? [], observedPages);

  /* The data requests each page of the report made while it was captured, whatever the origin: a fact of the page, so a claim that it asks the network for nothing can be held against it. The same pattern redaction every pack text passes (the run's secrets were taken out by value where the capture's output entered). */
  const requestLines = requestsSectionLines(
    [...pages.values()].flatMap((page) => (page.requests !== undefined && reportedRoutes.has(page.route) ? [{ route: page.route, ...(page.template !== undefined ? { template: page.template } : {}), requests: page.requests }] : [])),
  );
  const requestsSection = requestLines.length > 0 ? sanitizeText([`### ${PACK_HEADINGS.requests} ${REQUESTS_SECTION_INTRO}`, ...requestLines].join("\n"), "model").text : "";

  /* The data sources of one page that disagree on what their items carry (key names and counts read from the answers the page received), as facts of the page: a possible defect of the app's data that a test must not be written around. A signal; the same pattern redaction. */
  const shapePages = [...pages.values()].flatMap((page) => (page.shapes !== undefined && reportedRoutes.has(page.route) ? [{ route: page.route, ...(page.template !== undefined ? { template: page.template } : {}), shapes: page.shapes }] : []));
  const found = findDataContradictions(shapePages, input.responseFields);
  if (found.omitted > 0) log(`[qa] WARNING: ${found.omitted} possible data contradiction(s) were not listed, past the bound of one page (non-blocking).`);
  const dataContradictions = found.pages > 0 ? { read: found.pages, facts: found.facts } : undefined;
  const contradictionLines = contradictionsSectionLines(found.facts);
  const contradictionsSection = contradictionLines.length > 0 ? sanitizeText([`### ${PACK_HEADINGS.contradictions} ${CONTRADICTIONS_SECTION_INTRO}`, ...contradictionLines].join("\n"), "model").text : "";

  const domBytes = Buffer.byteLength(domSection, "utf8");
  const contractBytes = Buffer.byteLength(contractSection, "utf8");
  const trace: ContextPackTrace = domPack
    ? {
        rankedRoutes: firstPass,
        relevantRoutes: relevantMapRoutes,
        relevantGroups: relevantMapRoutes.map((route) => componentOf.get(route) ?? route),
        relevantBasis,
        capturablePages,
        pages: [...pages.values()],
        pageDeliveries: [...deliveries.values()],
        changedTestIds: (input.changedElements ?? []).flatMap((element) => (element.testId === undefined ? [] : [element.testId])),
        contractIds: relevantOps.map((op) => op.operationId),
        omittedLines: [...deliveries.values()].reduce((sum, delivery) => sum + delivery.nodeCapOmitted, 0),
      }
    : {
        rankedRoutes: [],
        relevantRoutes: [],
        relevantGroups: [],
        capturablePages: 0,
        pages: [],
        pageDeliveries: [],
        changedTestIds: [],
        contractIds: relevantOps.map((op) => op.operationId),
        omittedLines: 0,
      };

  const routeAvailability = domPack && input.availability !== undefined ? await classifyPackAvailability(input.availability, pages.values(), reportedRoutes, log) : undefined;
  const availabilityLines = availabilitySectionLines(routeAvailability?.facts ?? []);
  const availabilitySection = availabilityLines.length > 0 ? sanitizeText([`### ${PACK_HEADINGS.availability}`, ...availabilityLines].join("\n"), "model").text : "";
  const sections = [
    { text: domSection, held: "the live DOM of the routes it covers" },
    { text: changedValuesSection, held: "what the captured pages show of the values the change added and removed" },
    { text: requestsSection, held: "the data requests the captured pages made" },
    { text: contradictionsSection, held: "the data contradictions their pages show (possible defects)" },
    { text: redirectSection, held: "the pages reached by redirect (advisory)" },
    { text: availabilitySection, held: "why the routes not shown at their own address were not" },
    { text: contractSection, held: "the API contracts relevant to this objective" },
  ].filter(hasText);
  if (sections.length === 0) {
    return { text: undefined, domBytes: 0, contractBytes: 0, trace, ...(routeAvailability !== undefined ? { routeAvailability } : {}), ...(dataContradictions !== undefined ? { dataContradictions } : {}) };
  }
  /* The list of routes left out accompanies a pack that has something to say; it is no reason to make one. */
  sections.push(...[{ text: renderNotCapturable(notCaptured), held: "the routes not capturable, with why" }].filter(hasText));

  /* The header names the sections the pack actually rendered: a pack with no DOM never mentions one. */
  const held = sections.map((section) => section.held).join(" and ");
  const parts = sections.map((section) => section.text);
  const packHeader = [
    `## ${PACK_HEADINGS.pack} (pushed by the orchestrator before the first write)`,
    "",
    "The orchestrator built this pack deterministically before this session started.",
    `It holds ${held}.`,
    "",
  ].join("\n");

  const text = packHeader + parts.join("\n\n");
  return { text, domBytes, contractBytes, trace, ...(moreNodes.length > 0 ? { changedValuesWithMoreNodes: moreNodes } : {}), ...(routeAvailability !== undefined ? { routeAvailability } : {}), ...(dataContradictions !== undefined ? { dataContradictions } : {}) };
}
