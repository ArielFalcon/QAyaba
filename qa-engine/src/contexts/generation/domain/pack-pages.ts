/*
 * The part of a run's Context Pack one flow needs: the Live DOM of the pages it visits, under the section's own head. A sidekick
 * authors one flow; the trees of every other page would only crowd its brief. A page is the flow's when its address, or the map
 * template it was opened from, is one the flow names (a trailing slash and a query aside), or when the flow names another page of
 * that template, or one with a stand-in for a value (`namesTemplatePage`). Whole pages, every one: no fixed bound cuts them; the
 * prompt that carries them fits them to its role's window, page by page (referenceDomPages). Pure.
 */
import { PACK_HEADINGS } from "./prompt-headings.ts";
import { namesTemplatePage } from "./route-instantiation.ts";

const PAGE_LINE = /^route (\S+?)(?: \(instance of (\S+?)\))?:(?=\s|$)/;

const normalized = (route: string): string => {
  const path = route.replace(/[?#].*$/, "");
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
};
/* Any heading ends a section: the Live DOM section runs to the next one, whatever its level. */
const HEADING = /^#{1,6} /;

export function packPagesFor(pack: string | undefined, routes: readonly string[]): string | undefined {
  if (!pack || routes.length === 0) return undefined;
  const wanted = new Set(routes.map(normalized));
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
    if (wanted.has(normalized(route!))) return true;
    if (template === undefined) return false;
    const opened = normalized(template);
    return wanted.has(opened) || [...wanted].some((name) => namesTemplatePage(opened, name));
  });
  if (mine.length === 0) return undefined;
  return [...head, ...mine.map((page) => page.join("\n"))].join("\n");
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
