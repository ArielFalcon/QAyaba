/*
 * The part of a run's Context Pack one flow needs: the Live DOM of the pages it visits, under the section's own head. A sidekick
 * authors one flow; the trees of every other page would only crowd its brief. A page is the flow's when its address, or the map
 * template it was opened from, is one the flow names (a trailing slash and a query aside), or when the flow names another page of
 * that template, or one with a stand-in for a value (`namesTemplatePage`). Whole pages, every one: no fixed bound cuts them; the
 * prompt that carries them fits them to its role's window, page by page (referenceDomPages). The data requests those pages made
 * (the pack's requests section) come with them, as the facts of those pages only. Pure.
 */
import { PACK_HEADINGS } from "./prompt-headings.ts";
import { requestFactOf } from "./pack-requests.ts";
import { namesTemplatePage } from "./route-instantiation.ts";

const PAGE_LINE = /^route (\S+?)(?: \(instance of (\S+?)\))?:(?=\s|$)/;

const normalized = (route: string): string => {
  const path = route.replace(/[?#].*$/, "");
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
};
/* Any heading ends a section: the Live DOM section runs to the next one, whatever its level. */
const HEADING = /^#{1,6} /;

/* The pages a set of routes names, as the pack's pages are matched against them. */
export function wantedPages(routes: readonly string[]): ReadonlySet<string> {
  return new Set(routes.map(normalized));
}

/* Whether a captured page (its address, and the template it was opened from) is one the wanted routes name. */
export function pageIsNamed(route: string, template: string | undefined, wanted: ReadonlySet<string>): boolean {
  if (wanted.has(normalized(route))) return true;
  if (template === undefined) return false;
  const opened = normalized(template);
  return wanted.has(opened) || [...wanted].some((name) => namesTemplatePage(opened, name));
}

/* The facts of the pack's requests section for the wanted pages, in the pack's order; `heading` is the section's own heading line, when it holds any. */
function requestFactsFor(pack: string, wanted: ReadonlySet<string>): { heading?: string; facts: Array<{ line: string; request: string; counted: boolean }> } {
  let heading: string | undefined;
  const facts: Array<{ line: string; request: string; counted: boolean }> = [];
  let inSection = false;
  for (const line of pack.split("\n")) {
    if (HEADING.test(line)) {
      inSection = line.startsWith(`### ${PACK_HEADINGS.requests}`);
      if (inSection) heading = line;
      continue;
    }
    if (!inSection) continue;
    const fact = requestFactOf(line);
    if (fact && pageIsNamed(fact.route, fact.template, wanted)) facts.push({ line, request: fact.request, counted: fact.isOmittedCount });
  }
  return { ...(heading !== undefined ? { heading } : {}), facts };
}

/* The requests the pack recorded for the pages `routes` name (a page by its address, or by the template it was opened from), each as the fact states it. The line that counts what the capture left out is no request. A pack without the section records none. */
export function recordedRequestsFor(pack: string | undefined, routes: readonly string[]): string[] {
  if (!pack || routes.length === 0) return [];
  return requestFactsFor(pack, wantedPages(routes)).facts.filter((fact) => !fact.counted).map((fact) => fact.request);
}

export function packPagesFor(pack: string | undefined, routes: readonly string[]): string | undefined {
  if (!pack || routes.length === 0) return undefined;
  const wanted = wantedPages(routes);
  const head: string[] = [];
  const pages: string[][] = [];
  let inLiveDom = false;
  for (const line of pack.split("\n")) {
    if (HEADING.test(line)) {
      inLiveDom = line.startsWith(`### ${PACK_HEADINGS.liveDom}`);
      if (inLiveDom) head.push(line);
      continue;
    }
    if (!inLiveDom) continue;
    if (PAGE_LINE.test(line)) pages.push([line]);
    else if (pages.length === 0) head.push(line);
    else pages[pages.length - 1]!.push(line);
  }
  const mine = pages.filter(([first]) => {
    const [, route, template] = PAGE_LINE.exec(first!)!;
    return pageIsNamed(route!, template, wanted);
  });
  if (mine.length === 0) return undefined;
  const requests = requestFactsFor(pack, wanted);
  const requestLines = requests.facts.length === 0 ? [] : ["", requests.heading!, ...requests.facts.map((fact) => fact.line)];
  return [...head, ...mine.map((page) => page.join("\n")), ...requestLines].join("\n");
}

/* The lines of a pack text that are facts of one of its sections: the `- ` lines under the heading, which runs to the next heading. */
function sectionFactLines(lines: readonly string[], heading: string): number[] {
  const at: number[] = [];
  let inSection = false;
  lines.forEach((line, i) => {
    if (HEADING.test(line)) inSection = line.startsWith(`### ${heading}`);
    else if (inSection && line.startsWith("- ")) at.push(i);
  });
  return at;
}

/* How many facts a pack text's section holds, each of which can give way to a reference. */
export function sectionFactCount(text: string, heading: string): number {
  return sectionFactLines(text.split("\n"), heading).length;
}

/* The pack text with the last `count` facts of a section (the lowest-ranked, listed last) replaced by one line that counts them, `noun` naming what they are; with the fact lines it dropped. */
export function referenceSectionFacts(text: string, heading: string, count: number, noun: string): { text: string; left: number; dropped: string[] } {
  const lines = text.split("\n");
  const facts = sectionFactLines(lines, heading);
  const left = Math.min(Math.max(0, count), facts.length);
  if (left === 0) return { text, left: 0, dropped: [] };
  const dropped = new Set(facts.slice(facts.length - left));
  const last = facts[facts.length - 1];
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!dropped.has(i)) out.push(line);
    else if (i === last) out.push(`(${left} more ${noun}(s) are not shown here, to fit the window)`);
  });
  return { text: out.join("\n"), left, dropped: [...dropped].map((i) => lines[i]!) };
}

/* A page the window can leave out: the page the trace names it by (the template it was opened from, else its address) and how many lines of its own it held. */
export interface LeftOutPage {
  route: string;
  lines: number;
}

interface PageSpan {
  header: number;
  end: number;
  route: string;
}

/* The pages of a DOM text that hold lines of their own (a node, a note, the test ids), in order: a page's lines are the indented ones under its `route …:` line. With `section`, only the pages under that `### ` heading, which runs to the next heading. */
function pageSpans(lines: readonly string[], section?: string): PageSpan[] {
  const spans: PageSpan[] = [];
  let inScope = section === undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (section !== undefined && HEADING.test(line)) {
      inScope = line.startsWith(`### ${section}`);
      continue;
    }
    if (!inScope) continue;
    const match = PAGE_LINE.exec(line);
    if (!match) continue;
    let end = i + 1;
    while (end < lines.length && lines[end]!.startsWith("  ")) end++;
    if (end > i + 1) spans.push({ header: i, end, route: match[2] ?? match[1]! });
    i = end - 1;
  }
  return spans;
}

/* How many pages of a DOM text can give way to a reference. */
export function domPageCount(text: string, opts: { section?: string } = {}): number {
  return pageSpans(text.split("\n"), opts.section).length;
}

/*
 * The DOM text with its last `count` pages (those that hold lines of their own) shown as references: each keeps its `route …:` line,
 * so it is named, and one line saying how many of its lines are not shown. The order is the text's own: a pack lists the pages the
 * change ranks first first, so the lowest-ranked page gives way first. `left` names each page left out, in page order.
 */
export function referenceDomPages(text: string, count: number, opts: { section?: string } = {}): { text: string; left: LeftOutPage[] } {
  const lines = text.split("\n");
  const spans = pageSpans(lines, opts.section);
  const referenced = spans.slice(Math.max(0, spans.length - count));
  if (referenced.length === 0) return { text, left: [] };
  const out: string[] = [];
  let next = 0;
  for (const span of referenced) {
    const held = span.end - span.header - 1;
    out.push(...lines.slice(next, span.header + 1), `  (this page's ${held} line(s) are not shown here, to fit the window)`);
    next = span.end;
  }
  out.push(...lines.slice(next));
  return { text: out.join("\n"), left: referenced.map((span) => ({ route: span.route, lines: span.end - span.header - 1 })) };
}
