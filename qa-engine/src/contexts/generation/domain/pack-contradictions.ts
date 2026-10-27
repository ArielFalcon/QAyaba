/*
 * The possible data contradictions of the captured pages as a section of the Context Pack: one fact per contradiction,
 * `- <page>: <what the two sources returned>` (the caller writes the heading, with `CONTRADICTIONS_SECTION_INTRO`), in the order the
 * rule found them. A fact is what the orchestrator read in the responses the page's code received: key names and counts, never a
 * value. The facts give way to a count over a prompt's window (`referenceSectionFacts`), after every other fact of the pack, and a
 * flow's brief carries those of its pages (`packPagesFor`). Pure.
 */
import { dataContradictionStatement, type DataContradiction } from "@kernel/data-contradiction.ts";

/* How the section introduces itself: what the facts are, and what a test does with them. */
export const CONTRADICTIONS_SECTION_INTRO = `(two data sources of one page disagree on what their items carry, read from the answers the page received while it was captured: a possible defect of the app's data, not a fact to adapt a test to — a test that passes by reading its expected value from the state it checks, or by skipping a check when that state is empty, hides it)`;

/* How a page is named on a fact: its address, and the template it was opened from. */
const labelOf = (page: { route: string; template?: string }): string => (page.template === undefined ? page.route : `${page.route} (instance of ${page.template})`);

/* The section's facts, or none when no page shows a contradiction. */
export function contradictionsSectionLines(facts: readonly DataContradiction[]): string[] {
  return facts.map((fact) => `- ${labelOf(fact)}: ${dataContradictionStatement(fact)}`);
}
