/* Deterministic pre-generation context pack (DOM + explorer brief + contracts). Read-only on watched repos. Every component is fail-open: a failed piece yields an absent section, never a crashed run. */

import { sanitizeText } from "./sanitize-text.ts";
import { capDomLines, captureDomForRoutes, defaultCaptureDomDeps, MAX_ROUTES, REDIRECT_ADVISORY_INTRO } from "./dom-snapshot.ts";
import type { CapturedPage, CaptureDomDeps, CaptureRoutesInput } from "./dom-snapshot.ts";
import { loggableRoute, loggableRoutes } from "./loggable-route.ts";
import type { ExplorationBrief, ArchitectureContext, ApiOperation } from "../application/ports/generation-ports.ts";
import type { ChangedElement } from "../../../shared-kernel/diff-parser/changed-element.ts";
import { classifyRoutes, ROUTE_REASON } from "../../../shared-kernel/route-capturability.ts";
import { claim, type FactId, type PromptClaim } from "../domain/prompt-contract-lint.ts";
import { PACK_HEADINGS } from "../domain/prompt-headings.ts";
import { rankRoutesByChange } from "../domain/route-ranking.ts";
import { instantiableTemplate, instantiateRoute } from "../domain/route-instantiation.ts";
import { renderChangedValues, valuesWithMoreNodesThanLines, type ObservedPage } from "../domain/changed-values.ts";
import type { ChangedLiteral } from "../../../shared-kernel/diff-parser/changed-literal.ts";

export { PACK_HEADINGS };

const SECTION_FACTS: ReadonlyArray<readonly [string, FactId]> = [
  [PACK_HEADINGS.blastRadius, "blast-radius"],
  [PACK_HEADINGS.feBe, "fe-be-links"],
  [PACK_HEADINGS.risks, "risks"],
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
  brief?: ExplorationBrief;

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

  /* Before this field, candidateRoutes was populated ONLY from a brief (briefRoutePaths / contextMapRoutes gated on brief.feBe) — with the explorer pass unwired by design in production, there was NO brief-less route path at all, so the pack was structurally empty on every real run. */
  routes?: string[];

  /* Cross-repo runs only: where the triggering service's snapshot was staged, as the map may name it. Present (even empty) means prChangedFiles are the service's own files, so a route is ranked only by the spec of an operation it joins, under these roots. */
  stagedRoots?: string[];
}

export interface ContextPackAssembly {
  text: string | undefined;

  domBytes: number;
  contractBytes: number;
  /* The added values whose changed-value line states more nodes on a route than unchanged lines hold them. Absent when none does. */
  changedValuesWithMoreNodes?: string[];
}

export interface ContextPackDeps {
  captureDomForRoutes(
    routes: string[],
    input: CaptureRoutesInput,
    domDeps: CaptureDomDeps,
    changed?: ChangedElement[],
  ): Promise<string | undefined>;
  domDeps: CaptureDomDeps;
  log?: (msg: string) => void;
}


export const defaultContextPackDeps: ContextPackDeps = {
  captureDomForRoutes,
  domDeps: defaultCaptureDomDeps,
  log: (msg) => console.log(msg),
};


const DOM_BUDGET_BYTES = 30_000;

const BYTES_PER_CHAR = 1;


function filterRelevantContracts(
  contextMap: ArchitectureContext | undefined,
  brief: ExplorationBrief | undefined,
  prChangedFiles: string[] | undefined,
): ApiOperation[] {
  if (!contextMap || !contextMap.api?.length) return [];

  const relevantIds = new Set<string>();

  if (brief?.feBe?.length) {
    for (const link of brief.feBe) {
      if (link.operationId) relevantIds.add(link.operationId);
    }
  }

  if (brief?.contracts?.length) {
    for (const c of brief.contracts) {
      if (c.operationId) relevantIds.add(c.operationId);
    }
  }

  if (prChangedFiles?.length && contextMap.feBe?.length) {
    for (const link of contextMap.feBe) {
      const terms = [link.route, link.via ?? "", link.operationId].filter((t) => t && t.length >= 3);
      if (prChangedFiles.some((f) => terms.some((t) => f.includes(t)))) {
        relevantIds.add(link.operationId);
      }
    }
  }

  if (relevantIds.size === 0) return [];
  return contextMap.api.filter((op) => relevantIds.has(op.operationId)).slice(0, 50);
}


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
  /* The pages that could show a link to it were captured, and none did. */
  NO_LINK: `${ROUTE_REASON.TEMPLATE}: no link to a page of it was seen`,
  /* No page that could show a link to it was captured, so whether the site links to it is not known. */
  NO_PAGE_TO_LOOK_AT: `${ROUTE_REASON.TEMPLATE}: no page that could show a link to it was captured`,
  /* A link to a page of it was seen, but that page was not captured at its own address. */
  PAGE_NOT_CONFIRMED: `${ROUTE_REASON.TEMPLATE}: the page found for it could not be captured at its own address`,
} as const;

/* The routes left out of the capture because they name no single page, or no page of them was found, each with why. They are not degraded pages: nothing was captured for them. */
function renderNotCapturable(routes: readonly NotCaptured[]): string {
  if (routes.length === 0) return "";
  const listed = routes.slice(0, MAX_LISTED_UNCAPTURABLE).map((entry) => `- ${s(entry.route)} (${entry.reason})`);
  const more = routes.length - listed.length;
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
}

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

export async function buildContextPack(
  input: ContextPackInput,
  deps: ContextPackDeps,
): Promise<ContextPackAssembly> {
  const log = deps.log ?? (() => {});
  const domBudgetChars = Math.floor(DOM_BUDGET_BYTES / BYTES_PER_CHAR);

  let domSection = "";
  let redirectSection = "";
  const briefRoutePaths = new Set<string>(
    (input.brief?.routes ?? [])
      .filter((r) => r.path)
      .map((r) => r.path),
  );
  const contextMapRoutes = new Set<string>();
  if (input.contextMap?.feBe?.length && input.brief?.feBe?.length) {
    const briefOps = new Set(input.brief.feBe.map((l) => l.operationId));
    for (const link of input.contextMap.feBe) {
      if (briefOps.has(link.operationId) && link.route) contextMapRoutes.add(link.route);
    }
  }
  /* Only the routes the orchestrator derived itself are ranked by the change: the brief's own and the ones its operations join were chosen for this change already, and keep their place in front. With no changed file there is nothing to rank by. */
  const derivedRoutes = [...new Set(input.routes ?? [])];
  const deterministicRoutes = input.prChangedFiles
    ? rankRoutesByChange(derivedRoutes, input.contextMap, { changedFiles: input.prChangedFiles, ...(input.stagedRoots ? { stagedRoots: input.stagedRoots } : {}) })
    : derivedRoutes;
  /* A route named twice is counted once, and a route that names no page and no template of one is dropped, BEFORE the cut: neither may take the slot of a route behind it. A template stays in its place: it opens to a page through a link the site shows, and the cut is made on the pages, not on the templates. */
  const classified = classifyRoutes([...briefRoutePaths, ...contextMapRoutes, ...deterministicRoutes]);
  /* Only a route made of literals and whole-segment parameters can be filled from a link; any other route that names no page is simply left out. */
  const isTemplate = (entry: { route: string }): boolean => instantiableTemplate(entry.route);
  /* The pages the first capture renders: the routes that are pages, as many as the cut keeps. */
  const firstPass = classified.filter((entry) => entry.reason === undefined).map((entry) => entry.route).slice(0, MAX_ROUTES);
  /* A template can take a slot only if fewer than a cut's worth of pages rank ahead of it. */
  const reachableTemplates: string[] = [];
  let pagesAhead = 0;
  for (const entry of classified) {
    if (entry.reason === undefined) pagesAhead++;
    else if (isTemplate(entry) && pagesAhead < MAX_ROUTES) reachableTemplates.push(entry.route);
  }
  const reachable = reachableTemplates.length > 0;
  const pages = new Map<string, CapturedPage>();
  const captures: PackCapture[] = [];
  let renderedRoutes = 0;
  /* The routes the report covers: a page rendered only for its links is no part of it. */
  const reportedRoutes = new Set<string>();
  const capture = async (routes: string[], captureInput: CaptureRoutesInput): Promise<void> => {
    const rawCaptured = await deps.captureDomForRoutes(routes, { ...captureInput, onPages: (reported) => { for (const page of reported) pages.set(page.route, page); } }, deps.domDeps, input.changedElements);
    const raw = rawCaptured ? sanitizeText(rawCaptured, "model").text : rawCaptured;
    if (!raw) return;
    const { grounded, advisory } = splitRedirectSection(raw);
    captures.push({ grounded, advisory });
    renderedRoutes += routes.length;
    for (const route of routes) reportedRoutes.add(route);
  };
  /* What became of each template the run looked at: the page the links gave it, if any. A template behind the cut is never looked at. */
  const instanceOfTemplate = new Map<string, string | undefined>();
  if ((firstPass.length > 0 || reachable) && input.e2eDir && input.baseUrl) {
    const base = { e2eDir: input.e2eDir, baseUrl: input.baseUrl, testIdAttribute: input.testIdAttribute };
    try {
      /* The first capture is of the routes that are pages. When a template can still take a slot it also reports the links its pages show, and renders the app root for them when the root is no route asked for: the template cannot be opened, but a link to a page of it can. */
      await capture(firstPass, reachable && !firstPass.includes("/") ? { ...base, linkSeeds: ["/"] } : base);
      const links = [...new Set([...pages.values()].flatMap((page) => page.links))];
      /* The cut, made on pages in rank order: a route that is a page, or the page the links give a template. The first capture's pages are rendered already and stay in the pack even when the cut leaves them out. */
      const cut = new Set<string>();
      const instances = new Map<string, string>();
      for (const entry of classified) {
        if (cut.size >= MAX_ROUTES) break;
        /* A route that is a page and comes up before the cut is full is one of the first capture's: fewer than a cut's worth of pages came before it. */
        if (entry.reason === undefined) {
          cut.add(entry.route);
        } else if (isTemplate(entry)) {
          const instance = instantiateRoute(entry.route, links);
          instanceOfTemplate.set(entry.route, instance);
          if (instance === undefined) continue;
          cut.add(instance);
          if (!firstPass.includes(instance) && !instances.has(instance)) instances.set(instance, entry.route);
        }
      }
      if (instances.size > 0) {
        try {
          await capture([...instances.keys()], { ...base, instanceOf: instances });
        } catch (err) {
          log(`[qa] context-pack: DOM capture of the pages found for route templates FAILED (${err instanceof Error ? err.message : String(err)}) — those templates are not grounded`);
        }
      }
      if (captures.length > 0) {
        const lines = captures.map((c) => c.grounded).filter((text) => text !== "").join("\n").split("\n");
        const maxLines = Math.max(10, Math.floor(domBudgetChars / 60));
        const { kept, dropped } = capDomLines(lines, maxLines);
        redirectSection = captures.map((c) => c.advisory).reduce(joinRedirectSections, "");
        domSection = [
          `### ${PACK_HEADINGS.liveDom} (a11y tree — GROUND TRUTH for selectors)`,
          "These roles + accessible names are what the browser ACTUALLY exposes.",
          "Author selectors ONLY from what appears here — if a role is absent, it is NOT in the tree.",
          kept.join("\n"),
          ...(dropped > 0 ? [`(${dropped} non-priority element(s) omitted — see the full tree with the Playwright MCP if needed)`] : []),
        ].join("\n");
        log(`[qa] context-pack: DOM captured ${kept.length} lines for ${renderedRoutes} route(s)${dropped > 0 ? ` (${dropped} omitted)` : ""}`);
      } else {
        log(`[qa] context-pack: DOM capture returned nothing for routes [${loggableRoutes(firstPass)}] — grounding skipped`);
      }
    } catch (err) {
      log(`[qa] context-pack: DOM capture FAILED (${err instanceof Error ? err.message : String(err)}) — grounding skipped`);
      /* The links were never read: a template that was to be opened through them is unopened for that reason. */
      for (const template of reachableTemplates) instanceOfTemplate.set(template, undefined);
    }
  }
  /* What is left out: every route that names no single page, and the templates no grounded page was found for. A template is opened only when the page the links gave it was captured with content at its own address; a page that was not reported at all (a capture that failed, timed out or was unreadable) is not grounded. */
  const grounded = (route: string): boolean => pages.get(route)?.grounded === true;
  const anyPageGrounded = [...pages.values()].some((page) => page.grounded);
  const reasonFor = (entry: { route: string; reason?: string }): string | undefined => {
    if (!isTemplate(entry) || !instanceOfTemplate.has(entry.route)) return entry.reason;
    const instance = instanceOfTemplate.get(entry.route);
    if (instance === undefined) return anyPageGrounded ? TEMPLATE_LEFT_OUT.NO_LINK : TEMPLATE_LEFT_OUT.NO_PAGE_TO_LOOK_AT;
    return grounded(instance) ? undefined : TEMPLATE_LEFT_OUT.PAGE_NOT_CONFIRMED;
  };
  const notCaptured: NotCaptured[] = classified.flatMap((entry) => {
    const reason = reasonFor(entry);
    return reason === undefined ? [] : [{ route: entry.route, reason }];
  });
  for (const entry of notCaptured) log(`[qa] context-pack: route not capturable, left out of the capture: ${loggableRoute(entry.route)} (${entry.reason})`);

  let contractSection = "";
  const relevantOps = filterRelevantContracts(input.contextMap, input.brief, input.prChangedFiles);
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

  const domBytes = Buffer.byteLength(domSection, "utf8");
  const contractBytes = Buffer.byteLength(contractSection, "utf8");

  const sections = [
    { text: domSection, held: "the live DOM of the routes it covers" },
    { text: changedValuesSection, held: "what the captured pages show of the values the change added and removed" },
    { text: redirectSection, held: "the pages reached by redirect (advisory)" },
    { text: contractSection, held: "the API contracts relevant to this objective" },
  ].filter(hasText);
  if (sections.length === 0) {
    return { text: undefined, domBytes: 0, contractBytes: 0 };
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
  return { text, domBytes, contractBytes, ...(moreNodes.length > 0 ? { changedValuesWithMoreNodes: moreNodes } : {}) };
}
