/* Canonical DOM-grounding capture for the independent reviewer. The orchestrator (not the generator — independence holds) renders the routes the spec targets once and inlines real roles + accessible names into the reviewer prompt. Fail-open: a failed or empty render never blocks review. */

import { spawn } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import { ProcessKillAdapter } from "../../../shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { buildRouteCatalog, buildTestIdIndex, degradedRouteWarning, hasRuntimeErrorSignal, ROUTE_STATUS } from "./route-catalog.ts";
import type { ChangedElement } from "../../../shared-kernel/diff-parser/changed-element.ts";

const processKill = new ProcessKillAdapter();

export interface NodeAttr {
  key: string;
  testId?: string;
  id?: string;
  name?: string;
  href?: string;
  inputType?: string;
  nameFallback?: string;
}

export interface RawAttr {
  key: string;
  testId?: string;
  id?: string;
  name?: string;
  href?: string;
  inputType?: string;
  nameFallback?: string;
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
}

export interface CaptureDomInput {
  e2eDir: string;
  baseUrl: string;
  specContents: string[];
  testIdAttribute?: string;
}

export interface CaptureDomDeps {
  render(e2eDir: string, baseUrl: string, routes: string[], testIdAttribute?: string): Promise<RouteSnapshot[]>;
}

export const MAX_ROUTES = 4;
const MAX_NODES_PER_ROUTE = 60;
const MAX_ROUTES_UNION = 12;

/** Normalize an explicit route list the way capture does: trim, drop ${…}-interpolated and absolute URLs (not a stable app route), and dedupe. Exported so the fan-out keys its per-objective lookups IDENTICALLY to captureDomByRoute's map keys (a mismatch would silently lose grounding). */
export function normalizeRoutes(routes: string[]): string[] {
  return [...new Set(routes.map((r) => r.trim()).filter((r) => r && !r.includes("${") && !/^https?:\/\//i.test(r)))];
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

export function capDomLines(lines: string[], max: number): { kept: string[]; dropped: number } {
  if (lines.length <= max) return { kept: lines, dropped: 0 };
  const priorityCount = lines.filter(isPriorityNode).length;
  const afterPriority = Math.max(0, max - priorityCount);
  const interactiveNonPriority = lines.filter((n) => !isPriorityNode(n) && isInteractiveNode(n));
  const interactiveCount = Math.min(interactiveNonPriority.length, afterPriority);
  const otherBudget = Math.max(0, afterPriority - interactiveCount);
  let interactiveKept = 0;
  let othersKept = 0;
  const kept = lines.filter((n) => {
    if (isPriorityNode(n)) return true;
    if (isInteractiveNode(n)) return interactiveKept++ < interactiveCount;
    return othersKept++ < otherBudget;
  });
  return { kept, dropped: lines.length - kept.length };
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
}

export function buildChangedMarker(
  line: string,
  attr: NodeAttr | undefined,
  changed: ChangedElement[],
  testIdAttrName: string = "data-testid",
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
    if (c.text !== undefined) {
      const colonIdx = line.indexOf(": ");
      const rawNodeName = colonIdx !== -1 ? line.slice(colonIdx + 2).trim() : line.trim();
      const nodeName = rawNodeName.replace(ARIA_STATE_STRIP_RE, "").trim();
      if (nodeName) {
        const textLower = c.text.toLowerCase();
        const nodeNameLower = nodeName.toLowerCase();
        const exactMatch = nodeNameLower === textLower;
        const nodeWords = nodeNameLower.split(/\s+/).filter(Boolean);
        const wordMatch = nodeWords.includes(textLower);
        if (exactMatch || wordMatch) {
          return ` [CHANGED: added text "${c.text}"]`;
        }
      }
    }
  }
  return "";
}

export function formatDomSnapshot(snaps: RouteSnapshot[], changed?: ChangedElement[]): string {
  const lines: string[] = [];
  for (const s of snaps) {
    if (s.error) {
      lines.push(`route ${s.route}: (could not capture — ${s.error})`);
      continue;
    }
    /* A route that STRUCTURALLY failed to render (empty nodes, capture error, or a redirect — the buildRouteCatalog degrade policy) gets a warning line instead of a silent bare header and its nodes are NOT rendered: the agent must not trust this route's grounding. */
    if (buildRouteCatalog(s).status === ROUTE_STATUS.DEGRADED) {
      lines.push(`route ${s.route}: (route rendered empty or errored — possibly broken app; verify live)`);
      continue;
    }
    /* Live-probe fix: a route that DID render but whose app logged a runtime error (a missing icon, an uncaught handler, a framework error) stays a TRUSTED grounding source — its nodes ARE rendered below — but the agent still gets an advisory heads-up so it verifies live and does not blindly assert app-generated content. This warning is DECOUPLED from grounding trust: the route is captured, the selectors are real, only the app's own health is in question. */
    const runtimeErrorAdvisory = hasRuntimeErrorSignal(s.runtimeErrors ?? [])
      ? " (note: the app logged runtime errors — possibly a defect; verify live before asserting on app-generated content)"
      : "";
    const all = s.nodes ?? [];
    const { kept: nodes } = capDomLines(all, MAX_NODES_PER_ROUTE);
    const attrMap = s.attrs && s.attrs.length > 0
      ? new Map(s.attrs.map((a) => [a.key, a]))
      : null;
    const testIdAttrName = s.testIdAttrName ?? "data-testid";
    const useChanged = changed && changed.length > 0;
    const stateMap = s.states && s.states.size > 0 ? s.states : null;
    lines.push(`route ${s.route}:${runtimeErrorAdvisory}`);
    for (const n of nodes) {
      /* State suffix: rendered only for non-marker lines. The attrMap lookup uses the bare key (normalizeKey strips state if nodes[] ever carries a suffix — defensive); the state is looked up by the bare node string (nodes[] is always bare per the Option A invariant). */
      const stateSuffix = (!isMarkerLine(n) && stateMap?.get(normalizeKey(n)))
        ? ` [${stateMap.get(normalizeKey(n))!.join("] [")}]`
        : "";
      if (attrMap && !isMarkerLine(n)) {
        const attr = attrMap.get(normalizeKey(n)) ?? attrMap.get(n);
        if (attr) {
          const hint = buildAttrHint(attr, testIdAttrName);
          if (hint) {
            const changedMarker = useChanged ? buildChangedMarker(n, attr, changed!, testIdAttrName) : "";
            lines.push(`  ${n}  -> ${hint}${stateSuffix}${changedMarker}`);
            continue;
          }
        }
      }
      const changedMarker = useChanged && !isMarkerLine(n) ? buildChangedMarker(n, attrMap?.get(normalizeKey(n)) ?? attrMap?.get(n), changed!, testIdAttrName) : "";
      lines.push(`  ${n}${stateSuffix}${changedMarker}`);
    }
    if (all.length > nodes.length) lines.push(`  … (${all.length - nodes.length} more non-table elements omitted)`);
    if (s.testIds && s.testIds.size > 0) {
      const entries = [...s.testIds.entries()];
      const cap = MAX_NODES_PER_ROUTE;
      const shown = entries.slice(0, cap);
      const overflow = entries.length - shown.length;
      const parts = shown.map(([v, count]) => count > 1 ? `${v} (×${count})` : v);
      if (overflow > 0) parts.push(`(+${overflow} more)`);
      lines.push(`  test-ids on this route: ${parts.join(", ")}`);
    }
  }
  return lines.join("\n");
}

/** Capture the live DOM for the routes the spec targets. Returns undefined when there is nothing to capture or the render is unavailable — review then degrades to "defer on unverifiable UI facts" (the prompt's stay-in-your-lane rule), never blocked. Best-effort by design. */
export async function captureDom(input: CaptureDomInput, deps: CaptureDomDeps): Promise<string | undefined> {
  const routes = extractTargetRoutes(input.specContents);
  if (routes.length === 0 || !input.baseUrl) return undefined;
  try {
    const snaps = await deps.render(input.e2eDir, input.baseUrl, routes, input.testIdAttribute);
    const text = formatDomSnapshot(snaps);
    if (text.trim()) return text;
    /* Routes WERE extractable and a baseUrl WAS present, yet the render produced nothing. That is a real grounding GAP, not a benign no-op — surface it loudly (CLAUDE.md: never swallow into an empty result), so a run that authors/judges selectors WITHOUT the live DOM is visible. */
    console.warn(`[qa] WARNING: DOM grounding produced no snapshot for ${routes.length} route(s) [${routes.join(", ")}] — authoring/judging UI selectors WITHOUT the live DEV tree.`);
    return undefined;
  } catch (err) {
    console.warn(`[qa] WARNING: DOM grounding FAILED to capture ${routes.length} route(s) [${routes.join(", ")}] (${err instanceof Error ? err.message : String(err)}) — authoring/judging UI selectors WITHOUT the live DEV tree.`);
    return undefined;
  }
}

export async function captureDomForRoutes(
  routes: string[],
  input: { e2eDir: string; baseUrl?: string; testIdAttribute?: string },
  deps: CaptureDomDeps,
  changed?: ChangedElement[],
): Promise<string | undefined> {
  const clean = normalizeRoutes(routes).slice(0, MAX_ROUTES);
  if (clean.length === 0 || !input.baseUrl) return undefined;
  try {
    const snaps = await deps.render(input.e2eDir, input.baseUrl, clean, input.testIdAttribute);
    const w = degradedRouteWarning(snaps.map(buildRouteCatalog));
    if (w) console.warn(w);
    const text = formatDomSnapshot(snaps, changed);
    return text.trim() ? text : undefined;
  } catch (err) {
    console.warn(`[qa] WARNING: DOM capture FAILED for ${clean.length} route(s) [${clean.join(", ")}] (${err instanceof Error ? err.message : String(err)}) — the worker grounds via its own exploration this run.`);
    return undefined;
  }
}

/** Capture the live a11y tree for explicit routes, returned PER ROUTE (route → formatted block) so the fan-out can ground EACH objective with ONLY its own routes' DOM, not one shared blob. The whole set is rendered ONCE (a route shared by two objectives is not re-rendered) and split by route. Routes are taken from each brief's code-derived `routes[]` — the real router paths — so this does NOT key on the planner's `verified` flag (the planner no longer navigates to set it; see the F1/F3 seam). Best-effort: no routes / no baseUrl / a failed render → empty map, and each objective then degrades independently (an objective whose routes are absent from the map routes to the strong agent). Soft-404 / SPA-shell guard: a hash-routed SPA (e.g. That is NOT route-specific grounding — injecting it would teach a worker shell selectors as if they were the route's. We drop a node set ONLY when it is shared by a MAJORITY of the rendered routes (the signature of a real shell served for every path): `count >= 2 AND count > routes/2`. This avoids the false-positive of dropping two genuinely-distinct pages that merely share interactive chrome (their pair is not a majority of a >=4-route set), and a single unique route is never dropped (count 1). */
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
    console.warn(`[qa] WARNING: ${normalized.length} planned routes exceed the render cap (${MAX_ROUTES_UNION}); ${normalized.length - clean.length} route(s) are NOT grounded this run: ${normalized.slice(clean.length).join(", ")}`);
  }
  let snaps: RouteSnapshot[];
  try {
    snaps = await deps.render(input.e2eDir, input.baseUrl, clean, input.testIdAttribute);
  } catch (err) {
    console.warn(`[qa] WARNING: DOM capture FAILED for ${clean.length} route(s) [${clean.join(", ")}] (${err instanceof Error ? err.message : String(err)}) — each objective falls back to its own exploration this run.`);
    return out;
  }
  /* Per-route degrade: surface errored routes loudly (same pattern as captureRouteTrees — CLAUDE.md: never swallow a capture failure) before filtering them out for grounding. */
  const w = degradedRouteWarning(snaps.map(buildRouteCatalog));
  if (w) console.warn(w);
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
    /* Loud, attributed degrade (CLAUDE.md: never swallow a capture failure into []). The whole render threw → no pre-execution selector grounding this run; the gate has nothing and stays advisory. */
    console.warn(`[qa] WARNING: DOM capture FAILED for ${routes.length} route(s) [${routes.join(", ")}] (${err instanceof Error ? err.message : String(err)}) — no pre-execution selector grounding this run.`);
    return [];
  }
  const warning = degradedRouteWarning(snaps.map(buildRouteCatalog));
  if (warning) console.warn(warning);
  return snaps.filter((s) => !s.error && ((s.nodes?.length ?? 0) > 0 || (s.testIds?.size ?? 0) > 0));
}

export function parseAriaSnapshot(yaml: string): string[] {
  const out: string[] = [];

  const keep = new Set([
    "link", "button", "heading", "textbox", "combobox", "checkbox", "radio", "tab", "menuitem", "option",
    "columnheader", "rowheader", "cell", "gridcell", "listitem", "row", "table", "grid", "list",
    "text",
    /* These were absent from grounding, making the reviewer blind to modal presence, form context, and navigation structure. alert/status/progressbar are live-regions (name = the message); switch is a valued toggle widget (name = its label). All kept; structural designation is per-role below. */
    "dialog", "alertdialog", "alert", "status", "form", "navigation", "banner", "main", "switch", "progressbar",
  ]);
  /* Roles whose mere PRESENCE is informative even WITHOUT an accessible name, so we emit a bare "(present)" marker instead of dropping them: • landmarks (table/grid/list/row) — lets the author see "there is a table here" and reason about which roles it actually exposes (e.g. cells but no columnheader) vs assuming HTML-implied roles. • form inputs (textbox/combobox/checkbox/radio) — a form whose <label> is NOT associated (no for/id, common in apps like PetClinic) leaves the input UNNAMED; without this it is DROPPED and the whole form goes INVISIBLE to grounding, so the reviewer can't confirm the author's selectors and falsely REJECTS them. */
  const structural = new Set(["table", "grid", "list", "row", "textbox", "combobox", "checkbox", "radio",
    "dialog", "alertdialog", "form", "navigation", "banner", "main", "switch"]);

  for (const rawLine of yaml.split("\n")) {
    const trimmed = rawLine.trimStart();
    if (!trimmed.startsWith("- ")) continue;
    const rest = trimmed.slice(2).trim();

    if (rest.startsWith("/")) continue;

    const roleMatch = /^([a-z][a-z0-9-]*)/.exec(rest);
    if (!roleMatch) continue;
    const role = roleMatch[1]!;
    if (!keep.has(role)) continue;

    const afterRole = rest.slice(role.length);

    const quotedMatch = /"((?:\\.|[^"\\])*)"/.exec(afterRole);
    if (quotedMatch) {
      const name = quotedMatch[1]!.replace(/\\(["\\])/g, "$1").trim();
      out.push(name ? `${role}: ${name}` : structural.has(role) ? `${role}: (present)` : "");
      if (out[out.length - 1] === "") out.pop();
      continue;
    }

    const colonIdx = afterRole.indexOf(":");
    if (colonIdx !== -1) {
      const afterColon = afterRole.slice(colonIdx + 1).trim();
      if (afterColon) {
        const name = afterColon.replace(/\s*\[[^\]]*\]\s*$/g, "").trim();
        out.push(name ? `${role}: ${name}` : structural.has(role) ? `${role}: (present)` : "");
        if (out[out.length - 1] === "") out.pop();
      } else if (structural.has(role)) {
        out.push(`${role}: (present)`);
      }
      continue;
    }

    const strippedStates = afterRole.replace(/\s*\[[^\]]*\]/g, "").trim();
    if (!strippedStates && structural.has(role)) {
      out.push(`${role}: (present)`);
    }
  }

  return out;
}

export function parseAriaSnapshotWithState(yaml: string): { nodes: string[]; states: Map<string, string[]> } {
  const nodes = parseAriaSnapshot(yaml);
  const states = new Map<string, string[]>();
  const STATE_RE = /\[(disabled|expanded|checked|required|selected)\]/g;
  for (const rawLine of yaml.split("\n")) {
    const trimmed = rawLine.trimStart();
    if (!trimmed.startsWith("- ")) continue;
    const rest = trimmed.slice(2).trim();
    if (rest.startsWith("/")) continue;
    const roleMatch = /^([a-z][a-z0-9-]*)/.exec(rest);
    if (!roleMatch) continue;
    const role = roleMatch[1]!;
    const afterRole = rest.slice(role.length);
    let bareName: string | null = null;
    const quotedMatch = /"((?:\\.|[^"\\])*)"/.exec(afterRole);
    if (quotedMatch) {
      const name = quotedMatch[1]!.replace(/\\(["\\])/g, "$1").trim();
      if (name) bareName = name;
    } else {
      const colonIdx = afterRole.indexOf(":");
      if (colonIdx !== -1) {
        const afterColon = afterRole.slice(colonIdx + 1).trim();
        if (afterColon) {
          const name = afterColon.replace(/\s*\[[^\]]*\]\s*$/g, "").trim();
          if (name) bareName = name;
        }
      }
    }
    if (!bareName) continue;
    const bareKey = `${role}: ${bareName}`;
    if (!nodes.includes(bareKey)) continue;
    STATE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const tokens: string[] = [];
    while ((m = STATE_RE.exec(afterRole)) !== null) {
      tokens.push(m[1]!);
    }
    if (tokens.length > 0) states.set(bareKey, tokens);
  }
  return { nodes, states };
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

const RENDER_BASE_TIMEOUT_MS = 20_000;
const RENDER_PER_ROUTE_TIMEOUT_MS = 15_000;
const RENDER_MAX_TIMEOUT_MS = 200_000;
const renderTimeoutFor = (routeCount: number): number =>
  Math.min(RENDER_BASE_TIMEOUT_MS + Math.max(1, routeCount) * RENDER_PER_ROUTE_TIMEOUT_MS, RENDER_MAX_TIMEOUT_MS);

export function buildCaptureScript(playwrightRequirePath = "playwright"): string {
  return `const { chromium } = require(${JSON.stringify(playwrightRequirePath)});
const { baseUrl, routes } = JSON.parse(process.env.PW_CAPTURE_INPUT || "{}");
const testIdAttr = process.env.PW_TEST_ID_ATTRIBUTE || "data-testid";
(async () => {
  const out = [];
  let browser;
  try {
    browser = await chromium.launch();
    /* Gated routes: httpCredentials from DEV_ENV_USER / DEV_ENV_PASS (password may be empty). Scoped to baseUrl's origin so creds never leak to a different-origin auth provider. Gate is DEV_ENV_USER alone. */
    const user = process.env.DEV_ENV_USER;
    const pass = process.env.DEV_ENV_PASS;
    const context = await browser.newContext(user
      ? { httpCredentials: { username: user, password: pass ?? "", origin: new URL(baseUrl).origin } }
      : {});
    const page = await context.newPage();
    let currentRouteErrors = [];
    page.on("pageerror", function(err) { currentRouteErrors.push({ type: "pageerror", text: String(err && err.message || err) }); });
    page.on("console", function(msg) { if (msg.type() === "error") currentRouteErrors.push({ type: "console", text: msg.text() }); });
    for (const route of routes) {
      currentRouteErrors = [];
      try {
        await page.goto(new URL(route, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 10000 });
        let settled = false;
        try { await page.waitForLoadState("networkidle", { timeout: 5000 }); settled = true; } catch (_settle) {}
        const finalUrl = page.url();
        const yaml = await page.locator('body').ariaSnapshot();
        /* After ariaSnapshot(), query interactive/labelled nodes for stable HTML attributes. Chromium-only computedRole/computedName; if it throws, attrs is empty and the run degrades to a11y-only grounding. */
        let rawAttrs = [];
        try {
          rawAttrs = await page.evaluate(function(testIdAttrName) {
            var sel = 'a[href], button, input, select, textarea, [role], [' + testIdAttrName + '], [id], [name]';
            var els = Array.from(document.querySelectorAll(sel));
            return els.map(function(el) {
              var casted = el;
              var computedRole = '';
              var computedName = '';
              try { computedRole = casted.computedRole || ''; } catch(_e) {}
              try { computedName = casted.computedName || ''; } catch(_e) {}
              if (!computedRole) return null;
              var key = computedRole + ': ' + (computedName || '(present)');
              var result = { key: key };
              var testIdVal = el.getAttribute(testIdAttrName);
              if (testIdVal) result.testId = testIdVal;
              var idVal = el.getAttribute('id');
              if (idVal) result.id = idVal;
              var nameVal = el.getAttribute('name');
              if (nameVal) result.name = nameVal;
              var href = el.getAttribute('href');
              if (href && href.startsWith('/')) result.href = href;
              var tagName = el.tagName.toLowerCase();
              if (tagName === 'input' || tagName === 'textarea') {
                var typeVal = el.getAttribute('type');
                if (typeVal && typeVal !== 'text') result.inputType = typeVal;
                if (!computedName) {
                  var placeholder = el.getAttribute('placeholder');
                  var ariaLabel = el.getAttribute('aria-label');
                  var ariaLabelledby = el.getAttribute('aria-labelledby');
                  var fallback = placeholder || ariaLabel || '';
                  if (!fallback && ariaLabelledby) {
                    var labelEl = document.getElementById(ariaLabelledby);
                    if (labelEl) fallback = (labelEl.textContent || '').trim();
                  }
                  if (fallback) result.nameFallback = fallback;
                }
              }
              if (!result.testId && !result.id && !result.name && !result.href && !result.inputType && !result.nameFallback) return null;
              return result;
            }).filter(Boolean);
          }, testIdAttr);
        } catch(_attrErr) { rawAttrs = []; }
        let testIdRawList = [];
        try {
          testIdRawList = await page.evaluate(function(a) {
            return Array.from(document.querySelectorAll('[' + a + ']')).map(function(el) { return el.getAttribute(a); }).filter(function(v) { return v; });
          }, testIdAttr);
        } catch(_e) { testIdRawList = []; }
        out.push({ route, yaml, rawAttrs, testIdRawList, testIdAttr, settled, runtimeErrors: currentRouteErrors, finalUrl });
      } catch (e) { out.push({ route, error: String(e && e.message || e).slice(0, 200), runtimeErrors: currentRouteErrors }); }
    }
  } catch (e) { process.stderr.write(String(e)); } finally { if (browser) await browser.close().catch(() => {}); }
  process.stdout.write(JSON.stringify(out));
})();`;
}

export const defaultCaptureDomDeps: CaptureDomDeps = {
  render: (e2eDir, baseUrl, routes, testIdAttribute = "data-testid") =>
    new Promise<RouteSnapshot[]>((resolve) => {
      const work = mkdtempSync(join(tmpdir(), "qa-dom-"));
      const script = join(work, "capture.cjs");
      /* routes + baseUrl come from AGENT-AUTHORED specs (untrusted in this threat model). They are passed to the child via an ENV var and parsed there, NOT interpolated into the script source — JSON.stringify does not escape U+2028/U+2029, so interpolating untrusted strings into JS source could inject. The require() path is a derived LOCAL path (not agent input), so its interpolation is safe. */
      writeFileSync(script, buildCaptureScript(join(e2eDir, "node_modules", "playwright")));
      let stdout = "";
      /* detached → own process group so the timeout kill reaps the chromium grandchildren too (a plain child.kill would orphan them). scrubEnv({ extraAllowed: /^DEV_/ }) keeps the app's DEV_* login creds so gated routes snapshot the real page, not the login screen (same env as execute.ts). */
      const child = spawn("node", [script], {
        cwd: e2eDir,
        env: { ...scrubEnv({ extraAllowed: /^DEV_/ }), PW_BASE_URL: baseUrl, PW_TEST_ID_ATTRIBUTE: testIdAttribute, PW_CAPTURE_INPUT: JSON.stringify({ baseUrl, routes }) },
        detached: true,
      });
      const timer = setTimeout(() => processKill.killTree(child), renderTimeoutFor(routes.length));
      child.stdout.on("data", (d) => (stdout += d.toString()));
      const done = (snaps: RouteSnapshot[]): void => { clearTimeout(timer); try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ } resolve(snaps); };
      child.on("error", (err) => { console.warn(`[qa] WARNING: DOM capture script failed to spawn (${err instanceof Error ? err.message : String(err)}) — no grounding this run.`); done([]); });
      child.on("close", () => {
        try {
          const raw = JSON.parse(stdout) as Array<{ route: string; yaml?: string; rawAttrs?: RawAttr[]; testIdRawList?: string[]; testIdAttr?: string; settled?: boolean; error?: string; runtimeErrors?: { type: string; text: string }[]; finalUrl?: string }>;
          done(raw.map((r) => {
            if (r.error) {
              const errored: RouteSnapshot = { route: r.route, error: r.error };
              if (r.runtimeErrors && r.runtimeErrors.length > 0) errored.runtimeErrors = r.runtimeErrors;
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
            return snap;
          }));
        } catch {
          console.warn(`[qa] WARNING: DOM capture script produced unparseable output — no grounding this run.`);
          done([]);
        }
      });
    }),
};
