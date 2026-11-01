/* What the run already holds about where a changed file is reached, for the lead that routes a gap unit about it: the facts of the pages of the use cases the file seeds, each told from its own source and none derived here. Pure. */
import { availabilityLine, contradictionsReaching, namesTemplatePage } from "@contexts/generation/application/index.ts";
import { candidatesSeededBy } from "@kernel/change-map.ts";
import { dataContradictionRef, dataContradictionStatement, type DataContradiction, type DefectFact } from "@kernel/data-contradiction.ts";
import { printedRoute } from "@kernel/printed-route.ts";
import type { RouteAvailabilityFact } from "@kernel/route-availability.ts";
import { candidatePagesOf, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";

export interface GapReachFacts {
  candidates: readonly UseCaseCandidate[];
  /* The data contradictions of the pages the pack captured, and those of them that are a defect of the run. */
  contradictions: readonly DataContradiction[];
  defects: readonly DefectFact[];
  /* The pages the pack read as a confirmed empty state. */
  emptyPages: readonly string[];
  /* The routes the pack could not show at their own address. */
  availability: readonly RouteAvailabilityFact[];
}

/* The facts the run holds about the pages of the use cases `file` seeds, one statement each; none when no use case of the change is seeded by the file. */
export function gapReachOf(file: string, facts: GapReachFacts): string[] {
  const seeded = candidatesSeededBy(file, facts.candidates);
  if (seeded.length === 0) return [];
  const pages = [...new Set(seeded.flatMap(candidatePagesOf))];
  const onPages = (route: string, template?: string): boolean => pages.some((page) => namesTemplatePage(page, route) || (template !== undefined && namesTemplatePage(page, template)));
  const defects = new Set(facts.defects.map(({ fact }) => dataContradictionRef(fact)));
  const contradictions = [...new Set(seeded.flatMap((candidate) => contradictionsReaching(facts.contradictions, candidate)))];
  return [
    ...contradictions.map((fact) => `data contradiction on ${printedRoute(fact)}${defects.has(dataContradictionRef(fact)) ? " (a defect of the run)" : ""}: ${dataContradictionStatement(fact)}`),
    ...facts.emptyPages.filter((page) => onPages(page)).map((page) => `${page} was read as a confirmed empty state on DEV`),
    ...facts.availability.filter((fact) => onPages(fact.route, fact.template)).map((fact) => availabilityLine(fact).replace(/^- /, "")),
  ];
}
