/*
 * A deterministic first pass over the reviewer's own evidence: the spec's asserted counts and
 * selectors against the live DEV DOM the orchestrator captured. It answers only what the two can
 * prove against each other — an asserted count the page does not show, a test id its captured
 * inventory does not list, a named role the page does not expose — and only inside the part of the
 * spec that runs on the captured page as loaded (before the first click, or a second navigation).
 *
 * Everything else fails open. No DOM, no matching route, a degraded or truncated capture, an
 * unreadable spec, a regex or interpolated literal: no finding, and the model reviewer decides.
 * The contradiction it does report is a `[false-positive]` blocking correction, exactly what the
 * model reviewer would have to raise for the same evidence.
 */

import { REVIEW_CORRECTIONS_MAX } from "@contexts/generation/domain/review-output.ts";
import {
  confidentWindowEnd,
  extractProposedSelectorsWithIndex,
  extractTestIdSelectorsWithIndex,
  firstGotoRoute,
  normalizeName,
  selectorPresent,
  stripCommentsAndJoin,
} from "./helpers/selector-check.ts";

export interface ReviewSpecSource {
  /** The spec as the suite names it (relative to the spec directory). */
  file: string;
  text: string;
}

export interface ReviewPrecheckFinding {
  file: string;
  /** Already tagged `[false-positive]` and marked blocking, as the correction contract requires. */
  correction: string;
}

export interface ReviewPrecheckInput {
  specs: readonly ReviewSpecSource[];
  /** The assembled review DOM pack, as the reviewer receives it. Absent: nothing is checked. */
  domSnapshot?: string | undefined;
}

interface DomRouteBlock {
  route: string;
  /** `role: name` lines, with the formatter's attr hints and changed markers stripped. */
  lines: string[];
  /** The route's own test-id inventory, absent when the capture printed none. */
  testIds?: Set<string> | undefined;
  /** False when the capture failed, redirected, or said it omitted nodes: absence proves nothing. */
  complete: boolean;
}

const NODE_INDENT = /^\s{2,}/;
const TEST_IDS_LINE = /^test-ids on this route:\s*(.*)$/i;
const OMITTED_LINE = /^…\s*\(.*more non-table elements omitted\)/i;
const ROUTE_HEADER = /^route (.+)$/;

/* The address of a route header, without the suffix that explains a redirect, a failed capture or
 * the template it was opened from. A route itself may contain `:` (a template), so the separator is
 * the `: (` the formatter writes after the address, never the first colon on the line. */
function routeAddress(header: string): { route: string; degraded: boolean } {
  const suffixAt = header.indexOf(": (");
  const addressPart = (suffixAt === -1 ? header.replace(/:\s*$/, "") : header.slice(0, suffixAt)).trim();
  const suffix = suffixAt === -1 ? "" : header.slice(suffixAt + 1);
  const instanceAt = addressPart.indexOf(" (instance of ");
  const route = (instanceAt === -1 ? addressPart : addressPart.slice(0, instanceAt)).trim();
  const degraded = /(?:could not capture|redirected to)/i.test(suffix);
  return { route, degraded };
}

export function parseDomRouteBlocks(dom: string): DomRouteBlock[] {
  const blocks: DomRouteBlock[] = [];
  let current: DomRouteBlock | undefined;
  for (const raw of dom.split("\n")) {
    const header = ROUTE_HEADER.exec(raw);
    if (header) {
      const { route, degraded } = routeAddress(header[1] ?? "");
      current = { route, lines: [], complete: !degraded };
      blocks.push(current);
      continue;
    }
    /* A heading (the redirect advisory) ends the route pack this parser follows. */
    if (/^\s*#{1,6}\s/.test(raw)) {
      current = undefined;
      continue;
    }
    if (!current) continue;
    const line = raw.trim();
    if (!line) continue;
    if (OMITTED_LINE.test(line)) {
      current.complete = false;
      continue;
    }
    const testIds = TEST_IDS_LINE.exec(line);
    if (testIds) {
      const listed = testIds[1] ?? "";
      /* The inventory prints `(+N more)` when it is truncated: absence then proves nothing. */
      if (/\(\+\d+ more\)/i.test(listed)) current.complete = false;
      else current.testIds = new Set(listed.split(",").map((entry) => entry.replace(/\s*\(×\d+\)\s*$/, "").trim()).filter(Boolean));
      continue;
    }
    if (!NODE_INDENT.test(raw)) continue;
    /* The accessible name ends where the formatter's attr hint and changed marker begin. */
    const arrow = line.indexOf(" -> ");
    const withoutHint = (arrow === -1 ? line : line.slice(0, arrow)).trimEnd();
    current.lines.push(withoutHint.replace(/\s*\[CHANGED:[^\]]*\]\s*$/, ""));
  }
  return blocks;
}

const sameRoute = (a: string, b: string): boolean => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/* Asserted visible text: getByText and the text assertions. Template literals and regexes are
 * skipped wholesale — they are values, not the page's words. */
const LITERAL_PATTERNS: readonly RegExp[] = [
  /\.getByText\(\s*["'`]([^"'`]+)["'`]/g,
  /\.toContainText\(\s*["'`]([^"'`]+)["'`]/g,
  /\.toHaveText\(\s*["'`]([^"'`]+)["'`]/g,
  /\bhasText\s*:\s*["'`]([^"'`]+)["'`]/g,
];

function assertedLiterals(joined: string, windowEnd: number): string[] {
  const literals: Array<{ index: number; text: string }> = [];
  for (const pattern of LITERAL_PATTERNS) {
    pattern.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = pattern.exec(joined)) !== null; ) {
      const text = (m[1] ?? "").trim();
      /* A single generic word can match a different node as a substring; a count or a quantity is a
       * statement about this page. A phrase with no number may be a transient state (loading, error,
       * toast) the settled capture never shows — the model reviewer still judges it. Interpolation
       * is not a literal. */
      if (text.length < 4 || text.length > 120 || text.includes("${")) continue;
      if (!/[a-z]/i.test(text) || !/\d/.test(text)) continue;
      if (!isAssertedValue(joined, m.index) || assertsAbsence(joined, m.index)) continue;
      literals.push({ index: m.index, text });
    }
  }
  return literals
    .filter((literal) => literal.index < windowEnd)
    .map((literal) => literal.text);
}

/* Whether the value at `index` sits inside an `expect(...)`/`expect.soft(...)` call: only an
 * assertion claims something about the page. A locator used purely to click is not checked. */
function isAssertedValue(joined: string, index: number): boolean {
  const statementStart = Math.max(joined.lastIndexOf(";", index), joined.lastIndexOf("{", index), joined.lastIndexOf("}", index));
  return /\bexpect(?:\.\w+)?\s*\(/.test(joined.slice(statementStart + 1, index));
}

/* An assertion of absence agrees with a value the settled page does not show: `.not.`,
 * `.toBeHidden()`, `.toBeDetached()` and `.toHaveCount(0)` are never contradictions. */
function assertsAbsence(joined: string, index: number): boolean {
  const end = joined.indexOf(";", index);
  const statement = joined.slice(index, end === -1 ? joined.length : end);
  return /\.not\s*\./.test(statement) || /\.(?:toBeHidden|toBeDetached)\s*\(/.test(statement) || /\.toHaveCount\(\s*0\s*\)/.test(statement);
}

const normalized = (text: string): string => normalizeName(text).toLowerCase();

function correctionForLiteral(file: string, route: string, literal: string): string {
  return (
    `[false-positive] ${file}: asserts the text "${literal}", but the captured page at ${route} does not show it. ` +
    `A spec that asserts text the page does not render stays green on a page that lacks it; assert what the page shows, or drive that state through the UI first.`
  );
}

function correctionForSelector(file: string, route: string, selector: string): string {
  return (
    `[false-positive] ${file}: asserts ${selector}, but the captured page at ${route} does not expose it. ` +
    `The locator can never resolve against the real page; assert an element the page renders, or make it appear through the UI first.`
  );
}

function correctionForTestId(file: string, route: string, testId: string): string {
  return (
    `[false-positive] ${file}: uses the test id "${testId}", but the captured page at ${route} lists none. ` +
    `The locator can never resolve against the real page; use a locator the page exposes, or make the element appear through the UI first.`
  );
}

/* The findings for one spec. Empty on any uncertainty: that is the model reviewer's call. */
export function precheckSpecAgainstDom(spec: ReviewSpecSource, domSnapshot: string): ReviewPrecheckFinding[] {
  if (spec.text.trim() === "") return [];
  const route = firstGotoRoute(spec.text);
  if (route === undefined) return [];
  const block = parseDomRouteBlocks(domSnapshot).find((candidate) => sameRoute(candidate.route, route) && candidate.complete);
  if (!block) return [];
  /* A page tree with a handful of nodes is a real capture; an empty or one-line block is not
   * evidence of absence. */
  if (block.lines.length === 0) return [];

  const joined = stripCommentsAndJoin(spec.text);
  const windowEnd = confidentWindowEnd(spec.text);
  const findings: ReviewPrecheckFinding[] = [];
  const seen = new Set<string>();

  const push = (key: string, correction: string): void => {
    if (seen.has(key) || findings.length >= REVIEW_CORRECTIONS_MAX) return;
    seen.add(key);
    findings.push({ file: spec.file, correction });
  };

  const nodeText = block.lines.map(normalized);
  /* A page can render one visible phrase as several nodes ("0" in one, "resultados" in another);
   * the concatenation is what getByText's element text contains. Only absence from BOTH is evidence. */
  const concatenated = normalized(
    block.lines.map((line) => (line.includes(": ") ? line.slice(line.indexOf(": ") + 2) : line)).join(" "),
  );
  for (const literal of assertedLiterals(joined, windowEnd)) {
    const needle = normalized(literal);
    if (nodeText.some((line) => line.includes(needle)) || concatenated.includes(needle)) continue;
    push(`text:${needle}`, correctionForLiteral(spec.file, block.route, literal));
  }

  for (const { index, sel } of extractProposedSelectorsWithIndex(joined)) {
    if (index >= windowEnd || sel.kind === "text" || sel.isRegex || !sel.name) continue;
    if (!isAssertedValue(joined, index) || assertsAbsence(joined, index)) continue;
    const presence = selectorPresent(sel, block.lines);
    if (presence.present || !presence.verifiable) continue;
    const label = `${sel.role ?? sel.kind}${sel.name ? ` "${sel.name}"` : ""}`;
    push(`selector:${label}`, correctionForSelector(spec.file, block.route, label));
  }

  if (block.testIds) {
    for (const { value, index } of extractTestIdSelectorsWithIndex(joined)) {
      if (index >= windowEnd || block.testIds.has(value)) continue;
      if (!isAssertedValue(joined, index) || assertsAbsence(joined, index)) continue;
      push(`testid:${value}`, correctionForTestId(spec.file, block.route, value));
    }
  }

  return findings;
}

/** Every clear contradiction between the specs and the captured DOM, in spec order, capped. */
export function precheckSpecsAgainstDom(input: ReviewPrecheckInput): ReviewPrecheckFinding[] {
  if (!input.domSnapshot || input.domSnapshot.trim() === "") return [];
  return input.specs.flatMap((spec) => precheckSpecAgainstDom(spec, input.domSnapshot!)).slice(0, REVIEW_CORRECTIONS_MAX);
}
