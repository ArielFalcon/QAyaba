/* What the captured pages say about the labels a change added and removed, as facts: how many nodes of the captured trees show each value, how many unchanged lines of the changed file already hold it, and what the two counts allow to be said. Pure: the caller supplies the literals (the diff, and the file read for the unchanged lines) and the nodes (the live capture). Nothing here directs the agent; a count that does not exceed the unchanged lines is stated as such, never as a judgement of the change. */

import { PACK_HEADINGS } from "./prompt-headings.ts";
import type { ChangedLiteral } from "../../../shared-kernel/diff-parser/changed-literal.ts";

/* A grounded page of the capture: the nodes of its tree, one `role: name` per line. */
export interface ObservedPage {
  route: string;
  nodes: readonly string[];
}

/* The most routes named for one value; the count covers all of them. */
export const MAX_ROUTES_NAMED_PER_VALUE = 3;

export const CHANGED_VALUES_LEGEND =
  "Counts are of nodes in the captured trees and of unchanged lines in the changed file; nodes no more numerous than the unchanged lines that hold the value may come from those lines alone.";

export const CONCLUSION = {
  notObserved: "the changed element was not observed",
  observed: "observed",
  oldValueVisible: "old value still visible",
} as const;

const ARIA_STATE_SUFFIX = /(?:\s*\[(?:disabled|expanded|checked|required|selected|pressed|level=\d+)\])+\s*$/;

/* Whether a node line (`role: name`, optionally with states) shows a text: its name equals it, or has it as a whole word, whatever the case. */
export function nodeShowsText(nodeLine: string, text: string): boolean {
  const colon = nodeLine.indexOf(": ");
  const name = (colon !== -1 ? nodeLine.slice(colon + 2) : nodeLine).trim().replace(ARIA_STATE_SUFFIX, "").trim().toLowerCase();
  if (!name) return false;
  const wanted = text.toLowerCase();
  return name === wanted || name.split(/\s+/).filter(Boolean).includes(wanted);
}

/* A value as it is quoted in a line: one line, with no quote that could end the quotation. */
const quoted = (value: string): string => `"${value.replace(/\s+/g, " ").replace(/"/g, "'").trim()}"`;

interface Count {
  total: number;
  routes: string[];
}

function countShowing(value: string, pages: readonly ObservedPage[]): Count {
  let total = 0;
  const routes: string[] = [];
  for (const page of pages) {
    const shown = page.nodes.filter((node) => nodeShowsText(node, value)).length;
    if (shown === 0) continue;
    total += shown;
    routes.push(page.route);
  }
  return { total, routes };
}

const nodesPhrase = ({ total, routes }: Count): string => {
  if (total === 0) return "0 node(s) in the captured trees";
  const named = routes.slice(0, MAX_ROUTES_NAMED_PER_VALUE).join(", ");
  const more = routes.length - MAX_ROUTES_NAMED_PER_VALUE;
  return `${total} node(s) on ${named}${more > 0 ? ` (+${more} more)` : ""}`;
};

/* The line of a value the change added. The nodes are counted against the unchanged lines of the file: more nodes than those lines hold the value is a node the change introduced; no more is what the unchanged lines alone would render, or nothing at all. */
function addedLine(literal: ChangedLiteral, pages: readonly ObservedPage[]): string {
  const count = countShowing(literal.value, pages);
  const lines = literal.unchangedLines;
  const held = lines === undefined ? "" : `; ${lines} unchanged line(s) of ${literal.file} already contain it`;
  const head = `- changed value ${quoted(literal.value)}: ${nodesPhrase(count)}${held}`;
  if (count.total === 0) return `${head} → ${CONCLUSION.notObserved}`;
  if (lines === undefined) return head;
  return `${head} → ${count.total > lines ? CONCLUSION.observed : CONCLUSION.notObserved}`;
}

/* The line of a value the change removed, only when more nodes show it than unchanged lines hold it: the old value is on the page beyond what the file still says. */
function removedLine(literal: ChangedLiteral, pages: readonly ObservedPage[]): string | undefined {
  const lines = literal.unchangedLines;
  if (lines === undefined) return undefined;
  const count = countShowing(literal.value, pages);
  if (count.total <= lines) return undefined;
  return `- old value ${quoted(literal.value)}: ${nodesPhrase(count)}; ${lines} unchanged line(s) of ${literal.file} still contain it → ${CONCLUSION.oldValueVisible}`;
}

/* The section the pack carries, or "" when there is nothing to say: no captured page, or no literal that gives a line. */
export function renderChangedValues(literals: readonly ChangedLiteral[], pages: readonly ObservedPage[]): string {
  if (pages.length === 0) return "";
  const lines = literals.flatMap((literal) => {
    const line = literal.side === "added" ? addedLine(literal, pages) : removedLine(literal, pages);
    return line === undefined ? [] : [line];
  });
  return lines.length === 0 ? "" : [`### ${PACK_HEADINGS.changedValues}`, CHANGED_VALUES_LEGEND, ...lines].join("\n");
}
