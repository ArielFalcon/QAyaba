/* What the captured pages say about the labels a change added and removed, as facts that claim no more than the evidence shows: how many nodes each captured route shows of a value, how many unchanged lines of the changed file already hold it, and, only where a route shows more nodes than those lines could account for, that fact with its limit (no other file was checked). Pure: the caller supplies the literals (the diff, and the file read for the unchanged lines) and the nodes (the live capture). Nothing here directs the agent. */

import { PACK_HEADINGS } from "./prompt-headings.ts";
import type { ChangedLiteral } from "../../../shared-kernel/diff-parser/changed-literal.ts";

/* A grounded page of the capture: the nodes of its tree, one `role: name` per line. */
export interface ObservedPage {
  route: string;
  nodes: readonly string[];
}

/* The most routes named for one value; each is counted alone. */
export const MAX_ROUTES_NAMED_PER_VALUE = 3;

export const CHANGED_VALUES_LEGEND =
  "Counts are per route, of nodes in the captured trees, and of unchanged lines in the changed file only; no other file was checked.";

export const WORDING = {
  /* Nodes no more numerous than the unchanged lines that hold the value: they may all come from those lines. */
  ambiguous: "none can be attributed to the change",
  /* A route shows more nodes than the unchanged lines of the file hold the value. The limit follows it. */
  moreNodes: (file: string): string => `more nodes than unchanged lines of ${file}`,
  limit: "(other files not checked)",
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

interface RouteCount {
  route: string;
  nodes: number;
}

/* The routes that show the value, each with its own count. */
function countsPerRoute(value: string, pages: readonly ObservedPage[]): RouteCount[] {
  return pages
    .map((page) => ({ route: page.route, nodes: page.nodes.filter((node) => nodeShowsText(node, value)).length }))
    .filter((count) => count.nodes > 0);
}

const routesPhrase = (counts: readonly RouteCount[]): string => {
  const named = counts.slice(0, MAX_ROUTES_NAMED_PER_VALUE).map(({ nodes, route }) => `${nodes} node(s) on ${route}`).join(", ");
  const more = counts.length - MAX_ROUTES_NAMED_PER_VALUE;
  return `${named}${more > 0 ? ` (+${more} more)` : ""}`;
};

/* The routes on which more nodes show the value than unchanged lines of its file hold it. Unknown when the file was not read. */
function exceeding(counts: readonly RouteCount[], unchangedLines: number | undefined): RouteCount[] {
  return unchangedLines === undefined ? [] : counts.filter((count) => count.nodes > unchangedLines);
}

/* The line of a value the change added. */
function addedLine(literal: ChangedLiteral, pages: readonly ObservedPage[]): string {
  const counts = countsPerRoute(literal.value, pages);
  const lines = literal.unchangedLines;
  const head = `- changed value ${quoted(literal.value)}:`;
  const held = lines === undefined ? undefined : `${lines} unchanged line(s) of ${literal.file} already hold it`;
  if (counts.length === 0) return `${head} no captured node shows it${held ? `; ${held}` : ""}`;
  if (held === undefined) return `${head} ${routesPhrase(counts)} show it; unchanged lines of ${literal.file} were not read`;
  const beyond = exceeding(counts, lines);
  if (beyond.length === 0) return `${head} ${routesPhrase(counts)} show it and ${held}: ${WORDING.ambiguous}`;
  return `${head} ${routesPhrase(counts)} show it and ${held} → ${WORDING.moreNodes(literal.file)} on ${beyond.slice(0, MAX_ROUTES_NAMED_PER_VALUE).map((c) => c.route).join(", ")} ${WORDING.limit}`;
}

/* The line of a value the change removed, only when a route shows it by more nodes than unchanged lines hold it. */
function removedLine(literal: ChangedLiteral, pages: readonly ObservedPage[]): string | undefined {
  const lines = literal.unchangedLines;
  const counts = countsPerRoute(literal.value, pages);
  const beyond = exceeding(counts, lines);
  if (lines === undefined || beyond.length === 0) return undefined;
  return `- old value ${quoted(literal.value)}: ${routesPhrase(counts)} show it and ${lines} unchanged line(s) of ${literal.file} still hold it → ${WORDING.moreNodes(literal.file)} on ${beyond.slice(0, MAX_ROUTES_NAMED_PER_VALUE).map((c) => c.route).join(", ")} ${WORDING.limit}`;
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

/* The added values some route shows by more nodes than unchanged lines of the file hold them: the ones whose line carries the limit statement. */
export function valuesWithMoreNodesThanLines(literals: readonly ChangedLiteral[], pages: readonly ObservedPage[]): string[] {
  if (pages.length === 0) return [];
  return literals
    .filter((literal) => literal.side === "added" && exceeding(countsPerRoute(literal.value, pages), literal.unchangedLines).length > 0)
    .map((literal) => literal.value);
}
