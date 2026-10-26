/*
 * Which use cases of the change a lead's plan answers for. The admission set is the candidates the change reaches directly and
 * a browser can reach; a plan answers for one when a flow cites its id or visits one of its pages, or lists it as dropped with a
 * reason. What a plan leaves unresolved is asked of the lead once more (`renderReplanRequest`) and, still unresolved, is recorded
 * as unplanned. Pure: no clock, no file, no model.
 */

import { namesTemplatePage } from "@contexts/generation/application/index.ts";
import type { PlanDrop } from "./lead-plan.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { candidateLine, candidatePagesOf, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";

/* The most candidates a plan is required to answer for; the ones past it are shown as a count. */
export const MAX_ADMISSION_CANDIDATES = 12;
/* The lead's plan and one re-plan. */
export const MAX_PLAN_ROUNDS = 2;

export interface AdmissionSet {
  required: UseCaseCandidate[];
  /* The candidates the plan is not required to answer for. */
  others: number;
}

/* The direct candidates a browser reaches (a page, or an operation some page reaches), in the order `deriveCandidates` gives them. */
export function admissionSetOf(candidates: readonly UseCaseCandidate[] | undefined): AdmissionSet {
  const all = candidates ?? [];
  const required = all.filter((c) => c.tier === "direct" && c.reachability !== "backend-only").slice(0, MAX_ADMISSION_CANDIDATES);
  return { required, others: all.length - required.length };
}

/* The part of an admitted flow that coverage reads. */
export interface PlannedFlow {
  routes: readonly string[];
  candidates: readonly string[];
}

export interface PlanCoverage {
  covered: UseCaseCandidate[];
  dropped: Array<{ candidate: UseCaseCandidate; reason: string }>;
  unresolved: UseCaseCandidate[];
}

/* The page routes `visited` name, as a change page is named: a route is the page or one of its template's. */
export function unvisitedBy(pages: readonly string[], visited: readonly string[]): string[] {
  return pages.filter((page) => !visited.some((route) => namesTemplatePage(page, route)));
}

/* Whether the flow answers for the candidate: it cites the id, or visits one of the candidate's pages. */
export function flowCovers(flow: PlannedFlow, candidate: UseCaseCandidate): boolean {
  return flow.candidates.includes(candidate.id) || candidatePagesOf(candidate).some((page) => flow.routes.some((route) => namesTemplatePage(page, route)));
}

export function planCoverage(plan: { flows: readonly PlannedFlow[]; dropped: readonly PlanDrop[] }, admission: readonly UseCaseCandidate[]): PlanCoverage {
  const coverage: PlanCoverage = { covered: [], dropped: [], unresolved: [] };
  for (const candidate of admission) {
    if (plan.flows.some((flow) => flowCovers(flow, candidate))) {
      coverage.covered.push(candidate);
      continue;
    }
    const drop = plan.dropped.find((d) => d.candidate === candidate.id && d.reason !== "");
    if (drop) coverage.dropped.push({ candidate, reason: drop.reason });
    else coverage.unresolved.push(candidate);
  }
  return coverage;
}

/* The question the lead is asked when its plan leaves candidates unresolved: facts about the candidates and what a plan must do with each. The shape of the answer is the lead's role prompt. */
export function renderReplanRequest(redaction: RedactionPort, unresolved: readonly UseCaseCandidate[]): string {
  return [
    "## Use cases your plan leaves unresolved",
    "The change makes these use cases testable. No flow of your plan cites their id or visits their pages, and none is listed as dropped with a reason:",
    ...unresolved.map((candidate) => `- ${redaction.redact(candidateLine(candidate))}`),
    "Answer with your whole plan again: give a flow to each one (its id in the flow's \"candidates\"), or list it in \"dropped\" with the reason it needs no test. This is the only other plan turn of this run; answer with a plan of flows.",
  ].join("\n");
}
