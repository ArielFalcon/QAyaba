/* Canonical DOM-grounding capture for the independent reviewer. The orchestrator (not the generator — independence holds) renders the routes the spec targets once and inlines real roles + accessible names into the reviewer prompt. Fail-open: a failed or empty render never blocks review. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { AsyncResource } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redactByValue } from "../../../shared-kernel/run-secret-redaction.ts";
import type { ExecSandboxPort } from "../../../shared-infrastructure/process-sandbox/exec-sandbox.ts";
import { ProcessKillAdapter } from "../../../shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { BoundedWholeOutput } from "../../../shared-kernel/process-sandbox/bounded-whole-output.ts";
import { buildRouteCatalog, buildTestIdIndex, dataStateUnconfirmed, degradedRouteWarning, DEGRADE_REASON, gatedAppAdvisory, hasRuntimeErrorSignal, ROUTE_STATUS } from "./route-catalog.ts";
export { dataStateUnconfirmed } from "./route-catalog.ts";
import { PACK_HEADINGS } from "../domain/prompt-headings.ts";
import type { ChangedElement } from "../../../shared-kernel/diff-parser/changed-element.ts";
import { partitionRoutes } from "../../../shared-kernel/route-capturability.ts";
import { MAX_LINK_LENGTH, MAX_LINKS_PER_PAGE, sameOriginPathnames } from "../domain/route-instantiation.ts";
import { loggableRoutes } from "./loggable-route.ts";
import { dataStateRouteFor } from "../domain/data-state-route.ts";
import { parseAriaSnapshot, parseAriaSnapshotWithState } from "../domain/aria-snapshot.ts";
import type { NodeAttr, RepeatedName, RouteSnapshot } from "../domain/route-snapshot.ts";
import type { RouteNavigation } from "../domain/route-availability-classifier.ts";
import { pathOnly } from "@kernel/route-availability.ts";

const processKill = new ProcessKillAdapter();

/* The most a DOM capture run may print (one JSON document of every route's snapshot). The page content it reports is not under the orchestrator's control; a run that passes this is killed rather than held in memory and parsed truncated. */
export const MAX_CAPTURE_OUTPUT_CHARS = 32 * 1024 * 1024;



export interface RawAttr {
  key: string;
  testId?: string;
  id?: string;
  name?: string;
  href?: string;
  inputType?: string;
  nameFallback?: string;
}





/* The most containers reported for one occurrence, the most occurrences reported for a page, the longest container name kept, and the most names a page has resolved: the page decides all of them. */
export const MAX_SCOPE_DEPTH = 3;
export const MAX_REPEATED_PER_ROUTE = 200;
export const MAX_SCOPE_CHARS = 80;
export const MAX_NAMES_RESOLVED = 60;

/* The group of a pack line (`role: name`), as RepeatedName writes it; undefined for a line with no words. */
function nameGroup(line: string): string | undefined {
  const colon = line.indexOf(": ");
  if (colon === -1) return undefined;
  const words = line.slice(colon + 2).replace(ARIA_STATE_STRIP_RE, "").toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return words ? `${line.slice(0, colon)}|${words.join(" ")}` : undefined;
}

export interface CaptureDomInput {
  e2eDir: string;
  baseUrl: string;
  specContents: string[];
  testIdAttribute?: string;
}

export interface CaptureDomDeps {
  /* `probe`: containers (named as RepeatedName names them) whose absence from each page is reported in `absent`. */
  render(e2eDir: string, baseUrl: string, routes: string[], testIdAttribute?: string, probe?: readonly string[]): Promise<RouteSnapshot[]>;
  /* The browser position the capture opens pages with, when the app declares one. */
  readonly geolocation?: { latitude: number; longitude: number };
  /* Per-route data-state readiness/result/location selectors the capture reads at capture time (config data). */
  readonly dataState?: CaptureDataState;
}

/* The app's declared data-state readiness/result/location selectors, keyed by route path. A key with parameters (`/shops/:city`) names the pages that fill it segment by segment and a key ending `/*` a prefix and its root; a page is matched by its final pathname first, then the route asked for, each against an exact key, then a key with parameters, then a prefix (`dataStateRouteFor`). */
export interface CaptureDataState {
  routes: Record<string, {
    readySelector?: string;
    resultSelector?: string;
    resultTextSelector?: string;
    locationSelector?: string;
    timeoutMs?: number;
  }>;
}

/* How a route that structurally failed to render is stated in the snapshot: a plain state, no directive and no opinion about the app. */
export const DEGRADED_ROUTE_LABEL = "route rendered empty or errored";

export const MAX_ROUTES = 4;
/* The most pages one capture renders when the change is linked to more pages than MAX_ROUTES: each of them, up to this bound. */
export const MAX_ROUTES_PER_CHANGE = 8;
/* The most pages rendered only for the links they show. */
export const MAX_LINK_SEEDS = 1;
/*
 * The most nodes (and the most test ids) one page reports. It is a safety bound, not a budget: no ordinary page comes near it, and
 * what a prompt shows of a page is decided by its role's window (the window fit rule degrades pages to references). It holds a page
 * the orchestrator does not control (an endless list, a tree of millions of nodes) to a size the orchestrator can render and fit;
 * past it the priority nodes are kept (capDomLines), and what it leaves out is said on the page and counted for the trace.
 */
export const MAX_NODES_PER_PAGE = 5_000;
const MAX_ROUTES_UNION = 12;

/** Normalize an explicit route list the way capture does: trim, dedupe, and keep only the routes a browser can open as written (a template, free text, an interpolation or another host names no single page of the app). Exported so the fan-out keys its per-objective lookups IDENTICALLY to captureDomByRoute's map keys (a mismatch would silently lose grounding). */
export function normalizeRoutes(routes: string[]): string[] {
  return partitionRoutes(routes).capturable;
}

export function extractTargetRoutes(specContents: string[], max = MAX_ROUTES): string[] {
  const routes = new Set<string>();
  const re = /\.goto\(\s*[`'"]([^`'"]+)[`'"]/g;
  for (const src of specContents) {
    for (const line of src.split("\n")) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(line)) !== null) {
        const r = m[1]!.trim();
        if (r.includes("${") || /^https?:\/\//i.test(r)) continue;
        routes.add(r.startsWith("/") ? r : `/${r}`);
        if (routes.size >= max) return [...routes];
      }
    }
  }
  return [...routes];
}

const PRIORITY_ROLES = ["columnheader", "rowheader", "cell", "gridcell", "row", "table", "grid", "list", "listitem", "text"];
export const isPriorityNode = (line: string): boolean => PRIORITY_ROLES.some((r) => line.startsWith(`${r}:`));

const ARIA_STATE_STRIP_RE = /(?:\s*\[(disabled|expanded|checked|required|selected|pressed|level=\d+)\])+\s*$/;

export function normalizeKey(s: string): string {
  return s.replace(ARIA_STATE_STRIP_RE, "").replace(/\s+/g, " ").trim();
}

const INTERACTIVE_ROLES = ["button", "link", "textbox", "combobox", "checkbox", "radio"];
const isInteractiveNode = (line: string): boolean => INTERACTIVE_ROLES.some((r) => line.startsWith(`${r}:`));

/* The lines a bound keeps, priority nodes (tables, lists, text) first, then interactive ones, then the rest, in their own order; `keptIndices` names the input lines that survived. */
export function capDomLines(lines: string[], max: number): { kept: string[]; dropped: number; keptIndices: number[] } {
  if (lines.length <= max) {
    return { kept: lines, dropped: 0, keptIndices: lines.map((_, i) => i) };
  }
  const priorityCount = lines.filter(isPriorityNode).length;
  const afterPriority = Math.max(0, max - priorityCount);
  const interactiveNonPriority = lines.filter((n) => !isPriorityNode(n) && isInteractiveNode(n));
  const interactiveCount = Math.min(interactiveNonPriority.length, afterPriority);
  const otherBudget = Math.max(0, afterPriority - interactiveCount);
  let interactiveKept = 0;
  let othersKept = 0;
  const kept: string[] = [];
  const keptIndices: number[] = [];
  lines.forEach((n, i) => {
    const keep = isPriorityNode(n) ? true : isInteractiveNode(n) ? interactiveKept++ < interactiveCount : othersKept++ < otherBudget;
    if (keep) {
      kept.push(n);
      keptIndices.push(i);
    }
  });
  return { kept, dropped: lines.length - kept.length, keptIndices };
}

function buildAttrHint(attr: NodeAttr, testIdAttrName: string): string {
  const parts: string[] = [];
  if (attr.testId !== undefined) parts.push(`${testIdAttrName}=${attr.testId}`);
  else if (attr.id !== undefined) parts.push(`id=${attr.id}`);
  else if (attr.name !== undefined) parts.push(`name=${attr.name}`);
  else if (attr.href !== undefined) parts.push(attr.href);
  if (attr.inputType !== undefined) parts.push(`type=${attr.inputType}`);
  if (attr.nameFallback !== undefined) parts.push(attr.nameFallback);
  if (parts.length === 0) return "";
  const raw = parts.join(" ");
  const inner = raw.length > 40 ? raw.slice(0, 40) : raw;
  return `[${inner}]`;
}

function isMarkerLine(line: string): boolean {
  return line.includes(": (present)") || line.startsWith("text: ");
/* mutation-scope:begin changed-marker-tail */
}

export function buildChangedMarker(
  line: string,
  attr: NodeAttr | undefined,
/* mutation-scope:end changed-marker-tail */
  changed: ChangedElement[],
  testIdAttrName: string = "data-testid",
  /* The containers of this occurrence when its page repeats its name (see RepeatedName). */
  occurrenceScope?: readonly string[],
): string {
  if (!changed.length) return "";

  for (const c of changed) {
    if (c.testId !== undefined && attr?.testId === c.testId) {
      return ` [CHANGED: added ${testIdAttrName}=${c.testId}]`;
    }
    if (c.id !== undefined && attr?.id === c.id) {
      return ` [CHANGED: added id=${c.id}]`;
    }
    if (c.name !== undefined && attr?.name === c.name) {
      return ` [CHANGED: added name=${c.name}]`;
    }
    if (c.href !== undefined && attr?.href === c.href) {
      return ` [CHANGED: new link → ${c.href}]`;
    }
    /* mutation-scope:begin text-line-split */
    if (c.text !== undefined) {
      const colonIdx = line.indexOf(": ");
      const rawNodeName = colonIdx !== -1 ? line.slice(colonIdx + 2).trim() : line.trim();
      const nodeName = rawNodeName.replace(ARIA_STATE_STRIP_RE, "").trim();
      if (nodeName) {
        /* The changed text's words run, in order, through the node's name: case, punctuation and icon glyphs aside, as a locator matches a name. A hyphenated word is one word ("test" is not in "test-submission"). */
        const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) ?? [];
        const textWords = words(c.text);
        const nodeWords = words(nodeName);
        const carried = textWords.length > 0 && nodeWords.some((_, i) => textWords.every((w, j) => nodeWords[i + j] === w));
        if (carried) {
          /* The page repeats this text and the change's containers are known: only the occurrence inside one of them is the changed one. */
          if (occurrenceScope === undefined || !c.scope?.length) {
            /* A text-only change names no attribute to tell its node from another that shows the same text: when an unchanged line of its file already holds the text, a node showing it is as likely to come from that line, so it is no mark of the change. */
            const textOnly = c.testId === undefined && c.id === undefined && c.name === undefined && c.href === undefined;
            if (textOnly && (c.unchangedLines ?? 0) > 0) continue;
            return ` [CHANGED: added text "${c.text}"]`;
          }
          const inside = c.scope.find((container) => occurrenceScope.includes(container));
          if (inside !== undefined) return ` [CHANGED: added text "${c.text}" in ${inside}]`;
        }
      }
    }
  }
  return "";
}

/* The node lines of one route's tree: each node with its attribute hint, state and [CHANGED] mark, held to the node safety bound with a count of what it left out. */
    /* mutation-scope:end text-line-split */
function renderNodeLines(s: RouteSnapshot, allChanged?: ChangedElement[]): string[] {
  const lines: string[] = [];
  /* A change whose nearest container this page shows none of is not on this page now: it marks nothing here, and the page says so. */
  const notShown = (c: ChangedElement): boolean => c.scope?.[0] !== undefined && (s.absent ?? []).includes(c.scope[0]);
  const changed = allChanged?.filter((c) => !notShown(c));
  for (const c of allChanged ?? []) {
    if (notShown(c) && c.text !== undefined) lines.push(`  (the changed text "${c.text}" is in ${c.scope![0]} in the source; this page shows no ${c.scope![0]} now)`);
  }
  const all = s.nodes ?? [];
  const { kept: nodes } = capDomLines(all, MAX_NODES_PER_PAGE);
  const attrMap = s.attrs && s.attrs.length > 0
    ? new Map(s.attrs.map((a) => [a.key, a]))
    : null;
  const testIdAttrName = s.testIdAttrName ?? "data-testid";
  const useChanged = changed && changed.length > 0;
  const stateMap = s.states && s.states.size > 0 ? s.states : null;
  /* The repeated-name entry of each node line, in page order; the cap only drops lines, so the kept ones are found again in `all`. */
  const pending = new Map<string, RepeatedName[]>();
  for (const r of s.repeated ?? []) pending.set(r.group, [...(pending.get(r.group) ?? []), r]);
  const groups = all.map((n) => (isMarkerLine(n) ? undefined : nameGroup(n)));
  const occurrences = groups.map((g) => (g === undefined ? undefined : pending.get(g)?.shift()));
  /* A name's occurrences are told apart for the [CHANGED] mark only when one of them is in a container of the change: otherwise (a component that leaves no element on the page) every occurrence keeps the mark. */
  const changeContainers = new Set((changed ?? []).flatMap((c) => c.scope ?? []));
  const pinpointed = new Set((s.repeated ?? []).filter((r) => r.scope.some((container) => changeContainers.has(container))).map((r) => r.group));
  let cursor = 0;
  for (const n of nodes) {
    while (all[cursor] !== n) cursor++;
    const occurrence = occurrences[cursor++];
    const repeatedNote = occurrence
      ? ` (${occurrence.of} on this page with this name; ${occurrence.scope.length > 0 ? `in ${occurrence.scope.join(" < ")}` : "no container of its own"})`
      : "";
    /* State suffix: rendered only for non-marker lines. The attrMap lookup uses the bare key (normalizeKey strips state if nodes[] ever carries a suffix — defensive); the state is looked up by the bare node string (nodes[] is always bare per the Option A invariant). */
    const stateSuffix = (!isMarkerLine(n) && stateMap?.get(normalizeKey(n)))
      ? ` [${stateMap.get(normalizeKey(n))!.join("] [")}]`
      : "";
    if (attrMap && !isMarkerLine(n)) {
      const attr = attrMap.get(normalizeKey(n)) ?? attrMap.get(n);
      if (attr) {
        const hint = buildAttrHint(attr, testIdAttrName);
        if (hint) {
          const changedMarker = useChanged ? buildChangedMarker(n, attr, changed!, testIdAttrName, occurrence !== undefined && pinpointed.has(occurrence.group) ? occurrence.scope : undefined) : "";
          lines.push(`  ${n}  -> ${hint}${stateSuffix}${repeatedNote}${changedMarker}`);
          continue;
        }
      }
    }
    const changedMarker = useChanged && !isMarkerLine(n) ? buildChangedMarker(n, attrMap?.get(normalizeKey(n)) ?? attrMap?.get(n), changed!, testIdAttrName, occurrence !== undefined && pinpointed.has(occurrence.group) ? occurrence.scope : undefined) : "";
    lines.push(`  ${n}${stateSuffix}${repeatedNote}${changedMarker}`);
  /* mutation-scope:begin non-table-overflow-note */
  }
  if (all.length > nodes.length) lines.push(`  … (${all.length - nodes.length} more non-table elements left out by the safety bound of ${MAX_NODES_PER_PAGE} nodes per page)`);
  return lines;
}

/* How a page is named in the report: its address, and the template of the map it was opened from when it was. */
const routeLabel = (s: RouteSnapshot): string => (s.template === undefined ? s.route : `${s.route} (instance of ${s.template})`);

/* The grounded routes: each captured route with its tree and test-ids, and every other route as a plain state. A route that failed to capture, rendered empty or ended on another page renders NO tree here: the agent must not trust this route's grounding. The page a redirect reached is formatRedirectAdvisory's, never part of this text. */
export function formatDomSnapshot(snaps: RouteSnapshot[], changed?: ChangedElement[]): string {
  const lines: string[] = [];
  for (const s of snaps) {
    if (s.error) {
      lines.push(`route ${routeLabel(s)}: (could not capture — ${s.error})`);
      continue;
    }
    /* A route that STRUCTURALLY failed to render (empty nodes, or a redirect — the buildRouteCatalog degrade policy) gets a state line instead of a silent bare header and its nodes are NOT rendered. The state is a plain fact: it says which, and where a redirect went, with no directive and no opinion about the app. */
    const catalog = buildRouteCatalog(s);
    if (catalog.status === ROUTE_STATUS.DEGRADED) {
      lines.push(`route ${routeLabel(s)}: (${catalog.degradeReason === DEGRADE_REASON.REDIRECTED ? `redirected to ${catalog.redirectedTo}` : DEGRADED_ROUTE_LABEL})`);
      continue;
    }
    /* Live-probe fix: a route that DID render but whose app logged a runtime error (a missing icon, an uncaught handler, a framework error) stays a TRUSTED grounding source — its nodes ARE rendered below — but the agent still gets an advisory heads-up so it asserts only what this tree shows and does not blindly assert app-generated content. The note is data, not a directive: the prompt forbids re-navigating a route the tree covers, so it must never send the agent back to the page. This warning is DECOUPLED from grounding trust: the route is captured, the selectors are real, only the app's own health is in question. */
    const runtimeErrorAdvisory = hasRuntimeErrorSignal(s.runtimeErrors ?? [])
      ? " (note: the app logged runtime errors on this route — possibly a defect; assert only content this tree shows)"
      : "";
  /* mutation-scope:end non-table-overflow-note */
    lines.push(`route ${routeLabel(s)}:${runtimeErrorAdvisory}`);
    lines.push(...renderNodeLines(s, changed));
    if (s.testIds && s.testIds.size > 0) {
      const entries = [...s.testIds.entries()];
      const shown = entries.slice(0, MAX_NODES_PER_PAGE);
      const overflow = entries.length - shown.length;
      const parts = shown.map(([v, count]) => count > 1 ? `${v} (×${count})` : v);
      if (overflow > 0) parts.push(`(+${overflow} more)`);
      lines.push(`  test-ids on this route: ${parts.join(", ")}`);
    }
  }
  return lines.join("\n");
}

/* How the advisory block introduces itself: plain facts about what follows, in no trust vocabulary and with no directive. */
export const REDIRECT_ADVISORY_INTRO = "These routes sent the browser to another page. Each block below lists the page it reached, for orientation only: it is not the page of the route that was asked for.";

/** The pages redirects reached, as a section of their own under a heading naming it advisory: for each distinct page (a path with its tree), the routes that led there and the tree once. A route that failed, rendered empty or did not redirect is not here. Empty when no redirect reached a page with a tree. Never part of the grounded text: its trees were not the routes asked for. */
export function formatRedirectAdvisory(snaps: RouteSnapshot[]): string {
  const pages = new Map<string, { path: string; snap: RouteSnapshot; routes: string[] }>();
  for (const s of snaps) {
    if (s.error || s.nodes === undefined || s.nodes.length === 0) continue;
    const path = buildRouteCatalog(s).redirectedTo;
    if (path === undefined) continue;
    const key = `${path}\n${s.nodes.join("\n")}`;
    const page = pages.get(key);
    if (page) page.routes.push(s.route);
    else pages.set(key, { path, snap: s, routes: [s.route] });
  }
  if (pages.size === 0) return "";
  const lines = [`### ${PACK_HEADINGS.redirected} (ADVISORY)`, REDIRECT_ADVISORY_INTRO];
  for (const { path, snap, routes } of pages.values()) {
    lines.push(`reached ${path}, asked for ${routes.join(", ")}:`, ...renderNodeLines(snap));
  }
  return lines.join("\n");
}

/** What a capture of routes reports: the grounded routes, then (after a blank line) the pages redirects reached as a section of their own. Undefined when there is nothing to report. */
export function formatDomCapture(snaps: RouteSnapshot[], changed?: ChangedElement[]): string | undefined {
  const text = [formatDomSnapshot(snaps, changed), formatRedirectAdvisory(snaps)].filter((part) => part !== "").join("\n\n");
  return text === "" ? undefined : text;
}

/* Names the routes whose capture degraded, and, when the redirects look like a gated app, says so. Log only. */
function warnOnDegradedRoutes(snaps: readonly RouteSnapshot[]): void {
  const catalogs = snaps.map(buildRouteCatalog);
  const degraded = degradedRouteWarning(catalogs);
  if (degraded) engineLog.warn(degraded);
  const gated = gatedAppAdvisory(catalogs);
  if (gated) engineLog.warn(gated);
}

/** Capture the live DOM for the routes the spec targets. Returns undefined when there is nothing to capture or the render is unavailable — review then degrades to "defer on unverifiable UI facts" (the prompt's stay-in-your-lane rule), never blocked. Best-effort by design. */
export async function captureDom(input: CaptureDomInput, deps: CaptureDomDeps): Promise<string | undefined> {
  const routes = extractTargetRoutes(input.specContents);
  if (routes.length === 0 || !input.baseUrl) return undefined;
  try {
    const snaps = await deps.render(input.e2eDir, input.baseUrl, routes, input.testIdAttribute);
    const text = formatDomSnapshot(snaps);
    if (text.trim()) return text;
    /* Routes WERE extractable and a baseUrl WAS present, yet the render produced nothing. That is a real grounding GAP, not a benign no-op — surface it loudly (AGENTS.md: never swallow into an empty result), so a run that authors/judges selectors WITHOUT the live DOM is visible. */
    engineLog.warn(`[qa] WARNING: DOM grounding produced no snapshot for ${routes.length} route(s) [${loggableRoutes(routes)}] — authoring/judging UI selectors WITHOUT the live DEV tree.`);
    return undefined;
  } catch (err) {
    engineLog.warn(`[qa] WARNING: DOM grounding FAILED to capture ${routes.length} route(s) [${loggableRoutes(routes)}] (${err instanceof Error ? err.message : String(err)}) — authoring/judging UI selectors WITHOUT the live DEV tree.`);
    return undefined;
  }
}

export interface CaptureRoutesInput {
  e2eDir: string;
  baseUrl?: string;
  testIdAttribute?: string;
  /* Pages rendered only for the links they show, after the routes asked for: they are no part of the report. One already among the routes asked for is not rendered twice. */
  linkSeeds?: readonly string[];
  /* For a route asked for that is an instance of a template of the map, that template: the report names both. */
  instanceOf?: ReadonlyMap<string, string>;
  /* The most routes this capture renders (at most MAX_ROUTES_PER_CHANGE). Absent: MAX_ROUTES. */
  maxRoutes?: number;
  /* Told, once the render has answered, every page it returned (routes and seeds): whether the page is grounded and the links it showed. Never told when the render failed. */
  onPages?: (pages: CapturedPage[]) => void;
}

/* A page of a capture, as the caller that opens template pages must know it: grounded means the page rendered with content and ended on the address asked for, so what the report says of it is what that address shows. */
export interface CapturedPage {
  route: string;
  grounded: boolean;
  links: string[];
  /* For a page opened from a route template of the map, that template: the trace names the page's elements by it. */
  template?: string;
  /* The test ids the page carries, when it carries any (for the trace's change-value facts). */
  testIds?: string[];
  /* The delivery the trace needs: the kept nodes/test ids and the node→test-id map, for the delivered DOM ids. */
  keptNodes?: string[];
  keptTestIds?: string[];
  testIdOfNode?: Map<string, string>;
  nodeCapOmitted?: number;
  /* The address the page ended on, when the browser reported it. */
  finalUrl?: string;
  /* The capture-time data state of the page, when a dev.dataState route matched it. */
  dataState?: boolean;
  ready?: boolean;
  resultExpected?: boolean;
  resultCount?: number;
  emptyConfirmed?: boolean;
  effectiveLocation?: string;
  captureAttempts?: number;
  /* Whether the page's data state could not be confirmed at capture time (its result stayed empty, or its readiness never appeared). */
  dataStateUnconfirmed?: boolean;
  /* The node lines of its tree, one `role: name` each. Absent when the page did not report them. */
  nodes?: readonly string[];
  /* What the availability classification reads of the page's navigation. */
  navigation?: RouteNavigation;
}

/* What one captured page supplied and lost, for the trace: the kept nodes and test ids (within the node safety bound), the node→test-id map, and how many the bound left out. What a prompt shows of the page is the window's to decide, and its prompt records what the window left out. */
export interface PageDelivery {
  route: string;
  template?: string;
  keptNodes: string[];
  keptTestIds: string[];
  testIdOfNode: Map<string, string>;
  nodeCapOmitted: number;
}

/* One captured page as the trace needs it, from its raw snapshot: the nodes and test ids within the node safety bound, the node→test-id map, and how many the bound left out. A page opened from a template of the map is named by it. */
export function pageDeliveryOf(snap: RouteSnapshot, template?: string): PageDelivery {
  const nodes = snap.nodes ?? [];
  const testIds = [...(snap.testIds?.keys() ?? [])];
  const testIdOfNode = new Map<string, string>();
  for (const attr of snap.attrs ?? []) if (attr.testId !== undefined) testIdOfNode.set(attr.key, attr.testId);
  const keptNodes = capDomLines(nodes, MAX_NODES_PER_PAGE).kept;
  const keptTestIds = testIds.slice(0, MAX_NODES_PER_PAGE);
  return {
    route: template ?? snap.route,
    ...(template !== undefined ? { template } : {}),
    keptNodes,
    keptTestIds,
    testIdOfNode,
    nodeCapOmitted: Math.max(0, nodes.length - keptNodes.length) + Math.max(0, testIds.length - keptTestIds.length),
  };
}

export async function captureDomForRoutes(
  routes: string[],
  input: CaptureRoutesInput,
  deps: CaptureDomDeps,
  changed?: ChangedElement[],
): Promise<string | undefined> {
  const clean = normalizeRoutes(routes).slice(0, Math.min(input.maxRoutes ?? MAX_ROUTES, MAX_ROUTES_PER_CHANGE));
  const seeds = normalizeRoutes([...(input.linkSeeds ?? [])]).slice(0, MAX_LINK_SEEDS).filter((seed) => !clean.includes(seed));
  if ((clean.length === 0 && seeds.length === 0) || !input.baseUrl) return undefined;
  const asked = [...clean, ...seeds];
  try {
    const probe = [...new Set((changed ?? []).flatMap((c) => c.scope?.[0] ?? []))];
    const snaps = await deps.render(input.e2eDir, input.baseUrl, asked, input.testIdAttribute, probe);
    warnOnDegradedRoutes(snaps);
    input.onPages?.(snaps.map((snap) => {
      const template = input.instanceOf?.get(snap.route);
      const delivery = pageDeliveryOf(snap, template);
      return {
        route: snap.route,
        grounded: buildRouteCatalog(snap).status === ROUTE_STATUS.CAPTURED,
        links: snap.links ?? [],
        nodes: snap.nodes ?? [],
        ...(template !== undefined ? { template } : {}),
        ...(snap.testIds && snap.testIds.size > 0 ? { testIds: [...snap.testIds.keys()] } : {}),
        keptNodes: delivery.keptNodes,
        keptTestIds: delivery.keptTestIds,
        testIdOfNode: delivery.testIdOfNode,
        nodeCapOmitted: delivery.nodeCapOmitted,
        ...(snap.finalUrl !== undefined ? { finalUrl: snap.finalUrl } : {}),
        ...(snap.dataState !== undefined ? { dataState: snap.dataState } : {}),
        ...(snap.ready !== undefined ? { ready: snap.ready } : {}),
        ...(snap.resultExpected !== undefined ? { resultExpected: snap.resultExpected } : {}),
        ...(snap.resultCount !== undefined ? { resultCount: snap.resultCount } : {}),
        ...(snap.emptyConfirmed === true ? { emptyConfirmed: true } : {}),
        ...(snap.effectiveLocation !== undefined ? { effectiveLocation: snap.effectiveLocation } : {}),
        ...(snap.captureAttempts !== undefined ? { captureAttempts: snap.captureAttempts } : {}),
        dataStateUnconfirmed: dataStateUnconfirmed(snap),
        navigation: navigationOf(template === undefined ? snap : { ...snap, template }),
      };
    }));
    const reported = snaps
      .filter((snap) => !seeds.includes(snap.route))
      .map((snap) => {
        const template = input.instanceOf?.get(snap.route);
        return template === undefined ? snap : { ...snap, template };
      });
    return formatDomCapture(reported, changed);
  } catch (err) {
    engineLog.warn(`[qa] WARNING: DOM capture FAILED for ${asked.length} route(s) [${loggableRoutes(asked)}] (${err instanceof Error ? err.message : String(err)}) — the worker grounds via its own exploration this run.`);
    return undefined;
  }
}

/** Capture the live a11y tree for explicit routes, returned PER ROUTE (route → formatted block) so the fan-out can ground EACH objective with ONLY its own routes' DOM, not one shared blob. The whole set is rendered ONCE (a route shared by two objectives is not re-rendered) and split by route. Routes are taken from each brief's code-derived `routes[]` — the real router paths — so this does NOT key on the planner's `verified` flag (the planner does not navigate, so it never sets it). Best-effort: no routes / no baseUrl / a failed render → empty map, and each objective then degrades independently (an objective whose routes are absent from the map routes to the strong agent). Soft-404 / SPA-shell guard: a hash-routed SPA (e.g. That is NOT route-specific grounding — injecting it would teach a worker shell selectors as if they were the route's. We drop a node set ONLY when it is shared by a MAJORITY of the rendered routes (the signature of a real shell served for every path): `count >= 2 AND count > routes/2`. This avoids the false-positive of dropping two genuinely-distinct pages that merely share interactive chrome (their pair is not a majority of a >=4-route set), and a single unique route is never dropped (count 1). */
export async function captureDomByRoute(
  routes: string[],
  input: { e2eDir: string; baseUrl?: string; changedElements?: ChangedElement[]; testIdAttribute?: string },
  deps: CaptureDomDeps,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const normalized = normalizeRoutes(routes);
  const clean = normalized.slice(0, MAX_ROUTES_UNION);
  if (clean.length === 0 || !input.baseUrl) return out;
  if (normalized.length > clean.length) {
    engineLog.warn(`[qa] WARNING: ${normalized.length} planned routes exceed the render cap (${MAX_ROUTES_UNION}); ${normalized.length - clean.length} route(s) are NOT grounded this run: ${loggableRoutes(normalized.slice(clean.length))}`);
  }
  let snaps: RouteSnapshot[];
  try {
    snaps = await deps.render(input.e2eDir, input.baseUrl, clean, input.testIdAttribute);
  } catch (err) {
    engineLog.warn(`[qa] WARNING: DOM capture FAILED for ${clean.length} route(s) [${loggableRoutes(clean)}] (${err instanceof Error ? err.message : String(err)}) — each objective falls back to its own exploration this run.`);
    return out;
  }
  /* Per-route degrade: surface errored routes loudly (same pattern as captureRouteTrees — AGENTS.md: never swallow a capture failure) before filtering them out for grounding. */
  warnOnDegradedRoutes(snaps);
  const sig = (s: RouteSnapshot): string => (s.nodes ?? []).join("\n");
  const rendered = snaps.filter((s) => !s.error && s.nodes?.length);
  const occurrences = new Map<string, number>();
  for (const s of rendered) occurrences.set(sig(s), (occurrences.get(sig(s)) ?? 0) + 1);
  const isSharedShell = (s: RouteSnapshot): boolean => {
    const count = occurrences.get(sig(s)) ?? 0;
    return count >= 2 && count > rendered.length / 2;
  };
  for (const s of rendered) {
    if (isSharedShell(s)) continue;
    const text = formatDomSnapshot([s], input.changedElements);
    if (text.trim()) out.set(s.route, text);
  }
  return out;
}

/** Capture the per-route RAW node lines (`RouteSnapshot.nodes`) for the routes a SPEC targets — for the PRE-EXECUTION deterministic selector check (Lever-2 / checkSpecSelectors). Unlike captureDomByRoute (which formats per route and drops shared shells for worker grounding), this returns the raw nodes and applies NO shell-dedup: for strict-mode AMBIGUITY the real rendered tree IS the thing to check against, whatever the app's routing or rendering. Agnostic and best-effort: no routes / no baseUrl / a failed render / errored or empty-node routes all yield [] — the pre-execution signal is simply absent, never a break (the deterministic guarantee rests on the always-available post-failure path, not on this). */
export async function captureRouteTrees(input: CaptureDomInput, deps: CaptureDomDeps): Promise<RouteSnapshot[]> {
  const routes = extractTargetRoutes(input.specContents);
  if (routes.length === 0 || !input.baseUrl) return [];
  let snaps: RouteSnapshot[];
  try {
    snaps = await deps.render(input.e2eDir, input.baseUrl, routes, input.testIdAttribute);
  } catch (err) {
    /* Loud, attributed degrade (AGENTS.md: never swallow a capture failure into []). The whole render threw → no pre-execution selector grounding this run; the gate has nothing and stays advisory. */
    engineLog.warn(`[qa] WARNING: DOM capture FAILED for ${routes.length} route(s) [${loggableRoutes(routes)}] (${err instanceof Error ? err.message : String(err)}) — no pre-execution selector grounding this run.`);
    return [];
  }
  warnOnDegradedRoutes(snaps);
  return snaps.filter((s) => !s.error && ((s.nodes?.length ?? 0) > 0 || (s.testIds?.size ?? 0) > 0));
}





export function mergeAttrs(nodes: string[], rawAttrs: RawAttr[]): NodeAttr[] {
  if (rawAttrs.length === 0) return [];
  const byKey = new Map<string, RawAttr>();
  for (const r of rawAttrs) {
    const nk = normalizeKey(r.key);
    if (!byKey.has(nk)) byKey.set(nk, r);
  }
  const out: NodeAttr[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const bareKey = normalizeKey(node);
    if (seen.has(bareKey)) continue;
    const raw = byKey.get(bareKey);
    if (!raw) continue;
    if (raw.testId === undefined && raw.id === undefined && raw.name === undefined && raw.href === undefined
      && raw.inputType === undefined && raw.nameFallback === undefined) continue;
    seen.add(bareKey);
    const attr: NodeAttr = { key: bareKey };
    if (raw.testId !== undefined) attr.testId = raw.testId;
    if (raw.id !== undefined) attr.id = raw.id;
    if (raw.name !== undefined) attr.name = raw.name;
    if (raw.href !== undefined) attr.href = raw.href;
    if (raw.inputType !== undefined) attr.inputType = raw.inputType;
    if (raw.nameFallback !== undefined) attr.nameFallback = raw.nameFallback;
    out.push(attr);
  }
  return out;
}

/* The waits of one read of a route in the capture script: opening it, letting its requests go quiet, and a data state's wait when none is declared (a retry waits at most RETRY_DATA_STATE_WAIT_MS). */
const NAVIGATION_TIMEOUT_MS = 10_000;
const SETTLE_TIMEOUT_MS = 5_000;
const DEFAULT_DATA_STATE_WAIT_MS = 8_000;
const RETRY_DATA_STATE_WAIT_MS = 2_000;
/*
 * The least a read of a data state's selector may wait, however little of the data state's wait is left. Playwright reads an
 * element that is in the page at once and only auto-waits for one that is not yet; the seed gives an action 8 s
 * (PW_ACTION_TIMEOUT_MS), and the capture polls every 200 ms. 2 s is the share of that action timeout that covers a slow main
 * thread on a page that shows the element, without lengthening a capture by more than one read when the element never comes;
 * a read left a millisecond turned a visible "0 resultados" into no count (run-ed28973 recaptures).
 */
export const MIN_DATA_STATE_READ_MS = 2_000;
/* One read of a route at its slowest: opened, settled, and its tree, attributes, links and probes read. */
export const CAPTURE_ROUTE_READ_MS = NAVIGATION_TIMEOUT_MS + SETTLE_TIMEOUT_MS + 5_000;
/* The browser's start and the session's context, before the first route. */
const CAPTURE_START_MS = 20_000;
const CAPTURE_MAX_TIMEOUT_MS = 200_000;

/* How long a capture of `routes` may run before it is killed: a read of every route, plus, for a route a data state matches, its wait and a second read with the retry's wait. Bounded; a capture cut short keeps the routes it finished. */
export function captureTimeoutMs(routes: readonly string[], dataState?: CaptureDataState): number {
  const perRoute = routes.map((route) => {
    const state = dataState ? dataStateRouteFor(dataState.routes, route) : undefined;
    if (state === undefined) return CAPTURE_ROUTE_READ_MS;
    const wait = state.timeoutMs ?? DEFAULT_DATA_STATE_WAIT_MS;
    return CAPTURE_ROUTE_READ_MS + wait + MIN_DATA_STATE_READ_MS + CAPTURE_ROUTE_READ_MS + Math.min(wait, RETRY_DATA_STATE_WAIT_MS) + MIN_DATA_STATE_READ_MS;
  });
  const total = perRoute.length === 0 ? CAPTURE_ROUTE_READ_MS : perRoute.reduce((sum, ms) => sum + ms, 0);
  return Math.min(CAPTURE_START_MS + total, CAPTURE_MAX_TIMEOUT_MS);
}

/* The longest a link's whole address may be for the script to report it: the pathname the orchestrator keeps is held to MAX_LINK_LENGTH, so this leaves room for the origin and a query. */
const MAX_HREF_CHARS = MAX_LINK_LENGTH * 4;

/* The bounds the capture script holds the page to, handed to it in its input: the page decides what it shows, so these cap what it can make the script report. */
export const CAPTURE_LIMITS = {
  navigationTimeoutMs: NAVIGATION_TIMEOUT_MS,
  settleTimeoutMs: SETTLE_TIMEOUT_MS,
  defaultDataStateWaitMs: DEFAULT_DATA_STATE_WAIT_MS,
  retryDataStateWaitMs: RETRY_DATA_STATE_WAIT_MS,
  minDataStateReadMs: MIN_DATA_STATE_READ_MS,
  maxLinksPerPage: MAX_LINKS_PER_PAGE,
  maxHrefChars: MAX_HREF_CHARS,
  maxRepeatedPerRoute: MAX_REPEATED_PER_ROUTE,
  maxNamesResolved: MAX_NAMES_RESOLVED,
  maxScopeChars: MAX_SCOPE_CHARS,
  maxScopeDepth: MAX_SCOPE_DEPTH,
} as const;

/* The script is a typed, linted source file of its own (embedded/capture-dom.script.cjs); it is read once and handed to the launcher as text, with the one path it cannot know prepended. */
const CAPTURE_SCRIPT_SOURCE = readFileSync(new URL("./embedded/capture-dom.script.cjs", import.meta.url), "utf8");

export function buildCaptureScript(playwrightRequirePath = "playwright"): string {
  return `const PLAYWRIGHT_PATH = ${JSON.stringify(playwrightRequirePath)};\n${CAPTURE_SCRIPT_SOURCE}`;
}

/*
 * The capture script drives a browser from the e2e project's own `playwright` package, which the agent can install into
 * (it is agent-influenced code), so it starts through the execution launcher: the `suite` profile, the saved session as a
 * copy in the run's work dir, no account. REQUIRED, with no default: a capture that could start without the launcher
 * would run that package as the orchestrator. A caller that bypasses the type system still gets a loud throw here.
 */
/* The time the script reports for a route: a whole, non-negative number of milliseconds, within a day. The page cannot reach it, but the output is parsed defensively all the same. */
function routeMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 24 * 60 * 60 * 1000 ? Math.round(value) : undefined;
}

/* A data state's result count: a whole, non-negative number. */
function resultCountOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/* A data state's effective location: non-empty text, whitespace collapsed, capped. */
function effectiveLocationOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim().slice(0, 200);
  return cleaned || undefined;
}

/* How many times a data state was read: only a whole 1 or 2 is believed. */
function captureAttemptsOf(value: unknown): number | undefined {
  return value === 1 || value === 2 ? value : undefined;
}

/* Whether a captured page's data state could not be confirmed at capture time: a declared data state whose result was expected but stayed empty, or whose readiness selector never appeared. A page with no data state is never unconfirmed. */
/* (Defined in route-catalog.ts so the catalog's trust gate and the capture share one predicate.) */

/* The repeated names the script reports, keeping only well-formed entries within the bounds; undefined when none is left. */
function repeatedFrom(value: unknown): RepeatedName[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: RepeatedName[] = [];
  for (const entry of value.slice(0, MAX_REPEATED_PER_ROUTE)) {
    const { group, of, scope } = (entry ?? {}) as { group?: unknown; of?: unknown; scope?: unknown };
    if (typeof group !== "string" || !group.includes("|") || typeof of !== "number" || !Number.isInteger(of) || of < 2 || !Array.isArray(scope)) continue;
    const names = scope.filter((s): s is string => typeof s === "string" && s.length > 0).slice(0, MAX_SCOPE_DEPTH).map((s) => s.slice(0, 2 * MAX_SCOPE_CHARS)); /* room for the attribute a test id is wrapped in */
    out.push({ group: group.slice(0, 2 * MAX_SCOPE_CHARS), of, scope: names });
  }
  return out.length > 0 ? out : undefined;
}

/* The routes the capture script wrote, one JSON object per line (an earlier script wrote one array, still read). A line cut by a kill is not a route; output with no readable line throws, and the capture reports it unparseable. */
function captureLines(text: string): unknown[] {
  const entries: unknown[] = [];
  let unreadable = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (Array.isArray(parsed)) entries.push(...parsed);
      else if (parsed !== null && typeof parsed === "object") entries.push(parsed);
      else unreadable++;
    } catch {
      unreadable++;
    }
  }
  if (entries.length === 0 && unreadable > 0) throw new Error("no readable route in the capture output");
  return entries;
}

/* What the availability classification reads of one captured route. */
export function navigationOf(snap: RouteSnapshot): RouteNavigation {
  const catalog = buildRouteCatalog(snap);
  let finalPath: string | undefined;
  try {
    if (snap.finalUrl !== undefined) finalPath = new URL(snap.finalUrl).pathname;
  } catch {
    finalPath = undefined;
  }
  /* The document moved on the server when redirects led to it; it stayed where it was asked and the page moved the browser when its own pathname is the route's. */
  const asked = (() => { try { return new URL(snap.route, "http://q.invalid").pathname; } catch { return undefined; } })();
  const serverRedirect = snap.serverRedirects !== undefined && snap.serverRedirects > 0
    ? true
    : snap.documentPath !== undefined && asked !== undefined && pathOnly(snap.documentPath) === pathOnly(asked)
      ? false
      : undefined;
  return {
    route: snap.route,
    ...(snap.template !== undefined ? { template: snap.template } : {}),
    captureFailed: snap.error !== undefined,
    settled: snap.settled === true,
    nodes: snap.nodes?.length ?? 0,
    ...(finalPath !== undefined ? { finalPath } : {}),
    ...(snap.documentStatus !== undefined ? { documentStatus: snap.documentStatus } : {}),
    ...(serverRedirect !== undefined ? { serverRedirect } : {}),
    ...(snap.sessionAttached !== undefined ? { sessionAttached: snap.sessionAttached } : {}),
    runtimeError: hasRuntimeErrorSignal(snap.runtimeErrors ?? []),
    passwordField: catalog.reachedPasswordField === true,
  };
}

/* The navigation facts as the script reports them: untrusted until navigationFactsOf has read them. */
export interface RawNavigationFacts {
  documentStatus?: unknown;
  serverRedirects?: unknown;
  documentPath?: unknown;
  sessionAttached?: unknown;
}

/* The longest server redirect chain the readback believes; the script stops counting at it too. */
const MAX_SERVER_REDIRECTS = 20;

/* The navigation facts of one route as the capture reported them, each kept only when it is well formed: a status is an HTTP status, a redirect count a small whole number, a document path a bounded pathname. */
export function navigationFactsOf(raw: RawNavigationFacts): Pick<RouteSnapshot, "documentStatus" | "serverRedirects" | "documentPath" | "sessionAttached"> {
  const out: Pick<RouteSnapshot, "documentStatus" | "serverRedirects" | "documentPath" | "sessionAttached"> = {};
  if (Number.isInteger(raw.documentStatus) && (raw.documentStatus as number) >= 100 && (raw.documentStatus as number) <= 599) out.documentStatus = raw.documentStatus as number;
  if (Number.isInteger(raw.serverRedirects) && (raw.serverRedirects as number) >= 0 && (raw.serverRedirects as number) <= MAX_SERVER_REDIRECTS) out.serverRedirects = raw.serverRedirects as number;
  if (typeof raw.documentPath === "string" && raw.documentPath.startsWith("/") && raw.documentPath.length <= MAX_LINK_LENGTH && !/[\s\\\x00-\x1f\x7f]/.test(raw.documentPath)) out.documentPath = raw.documentPath;
  if (typeof raw.sessionAttached === "boolean") out.sessionAttached = raw.sessionAttached;
  return out;
}

/* What one run of the capture script came to, told to the optional observer once the script is done (or has failed, in which case there are no snapshots): the snapshots it returned, the routes it was asked for, and how much it printed. Read-only; it never changes what the capture returns. */
export interface DomCaptureReport {
  asked: readonly string[];
  snaps: readonly RouteSnapshot[];
  outputChars: number;
}
export type DomCaptureObserver = (report: DomCaptureReport) => void;

export function createCaptureDomDeps(
  exec: ExecSandboxPort,
  maxOutputChars: number = MAX_CAPTURE_OUTPUT_CHARS,
  observer?: DomCaptureObserver,
  geolocation?: { latitude: number; longitude: number },
  dataState?: CaptureDataState,
): CaptureDomDeps {
  if (!exec) {
    throw new Error("[qa] createCaptureDomDeps requires an execution launcher — there is no safe default (the capture loads a package from the agent-writable e2e project).");
  }
  return {
    ...(geolocation ? { geolocation } : {}),
    ...(dataState ? { dataState } : {}),
    render: (e2eDir, baseUrl, routes, testIdAttribute = "data-testid", probe = []) =>
      new Promise<RouteSnapshot[]>((resolve) => {
        /* routes + baseUrl come from AGENT-AUTHORED specs (untrusted in this threat model). They are passed to the child via an ENV var and parsed there, NOT interpolated into the script source — JSON.stringify does not escape U+2028/U+2029, so interpolating untrusted strings into JS source could inject. The require() path is a derived LOCAL path (not agent input), so its interpolation is safe. */
        const script = exec.writeScript("capture.cjs", buildCaptureScript(join(e2eDir, "node_modules", "playwright")));
        const stdout = new BoundedWholeOutput(maxOutputChars);
        /* The launcher starts the child detached, its own process group, so the timeout kill reaps the chromium grandchildren too (a plain child.kill would orphan them). The suite profile carries the DEV gate's credentials and the saved session, so gated routes snapshot the real page, not the login screen (same environment as a suite run). */
        const child = exec.spawn("node", [script], {
          cwd: e2eDir,
          profile: "suite",
          commandClass: "dom-capture",
          ...(geolocation ? { geolocation } : {}),
          extraEnv: {
            PW_BASE_URL: baseUrl,
            PW_TEST_ID_ATTRIBUTE: testIdAttribute,
            PW_CAPTURE_INPUT: JSON.stringify({ baseUrl, routes, probe, limits: CAPTURE_LIMITS }),
            ...(dataState ? { PW_CAPTURE_DATA_STATE: JSON.stringify(dataState) } : {}),
          },
          /* The result is the JSON on stdout; stderr is never read, and left piped it would block the script once the OS pipe buffer fills. */
          stdio: ["ignore", "pipe", "ignore"],
        });
        const timer = setTimeout(() => processKill.killTree(child), captureTimeoutMs(routes, dataState));
        let finished = false;
        /* Bound to the run's async context now, so the observer sees the run's open phase and secrets from the child's event callbacks. */
        const notify = observer ? AsyncResource.bind((report: DomCaptureReport) => observer(report)) : undefined;
        const done = (snaps: RouteSnapshot[]): void => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve(snaps);
          try {
            notify?.({ asked: routes, snaps, outputChars: stdout.text().length });
          } catch (err) {
            engineLog.error(`[qa] the DOM capture observer failed (the capture is unaffected): ${err instanceof Error ? err.message : String(err)}`);
          }
        };
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (d: string) => {
          stdout.append(d);
          if (!stdout.exceeded || finished) return;
          processKill.killTree(child);
          engineLog.warn(`[qa] WARNING: DOM capture output exceeded ${maxOutputChars} chars — killed, no grounding this run.`);
          done([]);
        });
        child.on("error", (err) => { engineLog.warn(`[qa] WARNING: DOM capture script failed to spawn (${err instanceof Error ? err.message : String(err)}) — no grounding this run.`); done([]); });
        child.on("close", () => {
          if (finished) return;
          try {
            /* The page decides what it shows, and it can show the account's password: the run's secrets are taken out of the document by value before it is read (a JSON-escaped spelling of each is replaced too). */
            const raw = captureLines(redactByValue(stdout.text())) as Array<{ route: string; yaml?: string; rawAttrs?: RawAttr[]; testIdRawList?: string[]; testIdAttr?: string; settled?: boolean; error?: string; runtimeErrors?: { type: string; text: string }[]; finalUrl?: string; hrefs?: unknown; repeated?: unknown; absent?: unknown; ms?: unknown; dataState?: unknown; ready?: unknown; resultExpected?: unknown; resultCount?: unknown; emptyConfirmed?: unknown; effectiveLocation?: unknown; captureAttempts?: unknown } & RawNavigationFacts>;
            const read = new Set(raw.map((r) => r.route));
            const unread = routes.filter((route) => !read.has(route));
            if (unread.length > 0) engineLog.warn(`[qa] WARNING: DOM capture ended before it read ${unread.length} route(s) [${loggableRoutes(unread)}] — those routes are not grounded.`);
            done(raw.map((r) => {
              if (r.error) {
                const errored: RouteSnapshot = { route: r.route, error: r.error };
                if (r.runtimeErrors && r.runtimeErrors.length > 0) errored.runtimeErrors = r.runtimeErrors;
                const erroredMs = routeMs(r.ms);
                if (erroredMs !== undefined) errored.ms = erroredMs;
                return errored;
              }
              const { nodes, states } = parseAriaSnapshotWithState(r.yaml ?? "");
              const attrs = r.rawAttrs && r.rawAttrs.length > 0 ? mergeAttrs(nodes, r.rawAttrs) : undefined;
              const snap: RouteSnapshot = { route: r.route, nodes };
              if (attrs && attrs.length > 0) snap.attrs = attrs;
              if (states.size > 0) snap.states = states;
              if (r.testIdAttr) snap.testIdAttrName = r.testIdAttr;
              const testIds = buildTestIdIndex(r.testIdRawList ?? []);
              if (testIds.size > 0) snap.testIds = testIds;
              if (r.settled === true) snap.settled = true;
              if (r.runtimeErrors && r.runtimeErrors.length > 0) snap.runtimeErrors = r.runtimeErrors;
              if (r.finalUrl) snap.finalUrl = r.finalUrl;
              const links = sameOriginPathnames(r.hrefs, baseUrl);
              if (links.length > 0) snap.links = links;
              const repeated = repeatedFrom(r.repeated);
              if (repeated) snap.repeated = repeated;
              /* Only names this capture asked about are believed. */
              const absent = Array.isArray(r.absent) ? probe.filter((name) => (r.absent as unknown[]).includes(name)) : [];
              if (absent.length > 0) snap.absent = absent;
              const snapMs = routeMs(r.ms);
              if (snapMs !== undefined) snap.ms = snapMs;
              if (r.dataState === true) snap.dataState = true;
              if (typeof r.ready === "boolean") snap.ready = r.ready;
              if (typeof r.resultExpected === "boolean") snap.resultExpected = r.resultExpected;
              const resultCount = resultCountOf(r.resultCount);
              if (resultCount !== undefined) snap.resultCount = resultCount;
              if (r.emptyConfirmed === true && resultCount === 0) snap.emptyConfirmed = true;
              const effectiveLocation = effectiveLocationOf(r.effectiveLocation);
              if (effectiveLocation !== undefined) snap.effectiveLocation = effectiveLocation;
              const captureAttempts = captureAttemptsOf(r.captureAttempts);
              if (captureAttempts !== undefined) snap.captureAttempts = captureAttempts;
              Object.assign(snap, navigationFactsOf(r));
              return snap;
            }));
          } catch {
            engineLog.warn(`[qa] WARNING: DOM capture script produced unparseable output — no grounding this run.`);
            done([]);
          }
        });
      }),
  };
}

/**
 * An INERT placeholder for the three composition seams (pre-exec/review-dom grounding adapters,
 * the context-pack default deps) that fall back to this when no captureDomDeps collaborator is
 * configured at all. It never touches the filesystem or spawns a process and never derives
 * credential paths from e2eDir. If it is ever actually invoked
 * (every real production wiring always overrides it with createCaptureDomDeps(exec) instead — see
 * run-engine-factory.ts), it fails loudly (AGENTS.md: never swallow — surface integration
 * errors loudly) rather than silently degrading to an insecure default.
 */
export const defaultCaptureDomDeps: CaptureDomDeps = {
  render: async () => {
    throw new Error(
      "[qa] defaultCaptureDomDeps.render was invoked without a real launcher-backed CaptureDomDeps. " +
      "Wire createCaptureDomDeps(exec) explicitly at this seam — there is no safe default.",
    );
  },
};
