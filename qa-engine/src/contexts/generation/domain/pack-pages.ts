/*
 * The part of a run's Context Pack one flow needs: the Live DOM of the pages it visits, under the section's own head. A sidekick
 * authors one flow; the trees of every other page would only crowd its brief. A page is the flow's when its address, or the map
 * template it was opened from, is one the flow names (a trailing slash and a query aside), or when the flow names another page of
 * that template, or one with a stand-in for a value (`namesTemplatePage`). Whole pages only, within a bound, and the pages the
 * bound leaves out are counted. Pure.
 */
import { PACK_HEADINGS } from "./prompt-headings.ts";
import { namesTemplatePage } from "./route-instantiation.ts";

export const MAX_FLOW_PACK_CHARS = 12_000;

const PAGE_LINE = /^route (\S+?)(?: \(instance of (\S+?)\))?:(?=\s|$)/;

const normalized = (route: string): string => {
  const path = route.replace(/[?#].*$/, "");
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
};
/* Any heading ends a section: the Live DOM section runs to the next one, whatever its level. */
const HEADING = /^#{1,6} /;

export function packPagesFor(pack: string | undefined, routes: readonly string[], maxChars: number = MAX_FLOW_PACK_CHARS): string | undefined {
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
  const kept: string[] = [...head];
  let size = kept.join("\n").length;
  let left = 0;
  for (const page of mine) {
    const text = page.join("\n");
    if (left > 0 || size + text.length + 1 > maxChars) {
      left += 1;
      continue;
    }
    kept.push(text);
    size += text.length + 1;
  }
  if (kept.length === head.length) return undefined;
  if (left > 0) kept.push(`(${left} more page${left === 1 ? "" : "s"} of this flow left out by the bound)`);
  return kept.join("\n");
}
