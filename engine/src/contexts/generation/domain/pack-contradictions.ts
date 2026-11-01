/*
 * The possible data contradictions of the captured pages as a section of the Context Pack: one fact per contradiction,
 * `- <page>: <what the answers lack and the consumer's code expects>` (the caller writes the heading, with `CONTRADICTIONS_SECTION_INTRO`),
 * in the order the rule found them. A fact is what the orchestrator read in the responses the page's code received (key names and
 * counts, never a value) set against what the consumer's own source expects of them. The facts give way to a count over a prompt's window (`referenceSectionFacts`), after every other fact of the pack, and a
 * flow's brief carries those of its pages (`packPagesFor`). Pure.
 */
import { dataContradictionStatement, type DataContradiction } from "@kernel/data-contradiction.ts";
import { seedingOf } from "@kernel/change-map.ts";
import { printedRoute } from "@kernel/printed-route.ts";
import { candidatePagesOf, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { namesTemplatePage } from "./route-instantiation.ts";

/* How the section introduces itself: what the facts are, and what a test does with them. */
export const CONTRADICTIONS_SECTION_INTRO = `(a field the consumer's own code expects of an answer — its declared response type holds it, non-test code reads it and nothing writes it — that no answer the page received while it was captured carries at any depth: a possible defect of the app's data or of the provider's contract, not a fact to adapt a test to — a test that passes by reading its expected value from the state it checks, or by skipping a check when that state is empty, hides it)`;

const fileOfSite = (site: string): string => site.replace(/:\d+$/, "");

/*
 * The contradictions that reach a use case: the page a fact was found on is one of its pages, or a file that seeds it, directly or as
 * a hub's shared code (`seedingOf`, the seed definition the change map, the briefs and the routing of a finding share), holds the
 * fact's call site or one of the sites that read the field.
 */
export function contradictionsReaching(facts: readonly DataContradiction[], candidate: UseCaseCandidate): DataContradiction[] {
  const pages = candidatePagesOf(candidate);
  return facts.filter(
    (fact) =>
      pages.some((page) => namesTemplatePage(page, fact.route) || (fact.template !== undefined && namesTemplatePage(page, fact.template))) ||
      [fact.consumer.callSite, ...fact.consumer.reads].some((site) => seedingOf(fileOfSite(site), candidate) !== undefined),
  );
}

/* The section's facts, or none when no page shows a contradiction. */
export function contradictionsSectionLines(facts: readonly DataContradiction[]): string[] {
  return facts.map((fact) => `- ${printedRoute(fact)}: ${dataContradictionStatement(fact)}`);
}
