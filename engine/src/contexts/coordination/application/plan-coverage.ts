/*
 * Which use cases of the change a lead's plan answers for. The admission set is the candidates the change reaches directly and
 * a browser can reach; a plan answers for one when a flow cites its id or visits one of its pages, or lists it as dropped with a
 * reason. What a plan leaves unresolved is asked of the lead once more (`renderReplanRequest`), in the one amendment turn that also
 * names the flows past the run's capacity and those too large for one author, and, still unresolved, is recorded as unplanned.
 * Pure: no clock, no file, no model.
 */

import { namesTemplatePage } from "@contexts/generation/application/index.ts";
import type { NotAdmittedFlow, PlanDrop } from "./lead-plan.ts";
import { DROP_BASIS, dropRefusal } from "@kernel/drop-basis.ts";
import type { OwnedSliceSize } from "@kernel/use-case-candidate.ts";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { candidatePagesOf, type UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { assembleDefs, type AssembledPrompt } from "@kernel/prompt-sections.ts";
import { REPLAN_SECTIONS } from "./coordination-sections/replan-sections.ts";

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
  dropped: Array<{ candidate: UseCaseCandidate; reason: string; /* Set when the lead kept a drop the facts contradicted: honored, and recorded. */ contradicted?: { basis: PlanDrop["basis"]; why: string } }>;
  unresolved: UseCaseCandidate[];
  /* The drops the orchestrator's facts contradict, with why: their candidates are also in `unresolved`. */
  refused?: Array<{ candidate: UseCaseCandidate; basis: PlanDrop["basis"]; why: string }>;
}

/*
 * What the lead decided after it was shown the fact that contradicts a drop. The fact (a code file with added lines, no spec linked) is
 * a signal, not proof: a refactor, a type-only or a comment edit has changed code and nothing a browser can observe. So a drop that
 * is still refused after the one re-ask stands as the lead's decision and moves from `unresolved` to `dropped`, carrying the
 * contradiction for graders and reports to count. Never an infra error.
 */
export function honorContradictedDrops(coverage: PlanCoverage): PlanCoverage {
  if (coverage.refused === undefined || coverage.refused.length === 0) return coverage;
  const refused = new Map(coverage.refused.map((r) => [r.candidate.id, r]));
  const honored = coverage.unresolved.flatMap((candidate) => {
    const r = refused.get(candidate.id);
    return r ? [{ candidate, reason: `${r.basis}: contradicted by the run's facts (${r.why})`, contradicted: { basis: r.basis, why: r.why } }] : [];
  });
  return { covered: coverage.covered, dropped: [...coverage.dropped, ...honored], unresolved: coverage.unresolved.filter((c) => !refused.has(c.id)) };
}

/* The drops of a plan that dropped everything without saying which: a declared no-op decides about each use case the change makes testable, on the basis that nothing a browser can observe changed. */
export function impliedNoopDrops(reason: string, admission: readonly UseCaseCandidate[]): PlanDrop[] {
  return admission.map((candidate) => ({ candidate: candidate.id, basis: DROP_BASIS.NO_OBSERVABLE_CHANGE, reason }));
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
  const refused: NonNullable<PlanCoverage["refused"]> = [];
  for (const candidate of admission) {
    if (plan.flows.some((flow) => flowCovers(flow, candidate))) {
      coverage.covered.push(candidate);
      continue;
    }
    const drop = plan.dropped.find((d) => d.candidate === candidate.id && d.reason !== "");
    const why = drop ? dropRefusal(candidate, drop.basis) : undefined;
    if (drop && why === undefined) coverage.dropped.push({ candidate, reason: `${drop.basis}: ${drop.reason}` });
    else {
      coverage.unresolved.push(candidate);
      if (drop && why !== undefined) refused.push({ candidate, basis: drop.basis, why });
    }
  }
  return refused.length > 0 ? { ...coverage, refused } : coverage;
}

/* What the amendment turn asks about besides the use cases: the flows past the run's capacity, the flows too large for one author, and the change each candidate would own. */
export interface PlanAmendment {
  capacity?: number;
  /* The flows the admitted plan holds, which the amendment's answer replaces. */
  admitted?: number;
  notAdmitted?: readonly NotAdmittedFlow[];
  oversize?: ReadonlyArray<{ id: string; size: OwnedSliceSize }>;
  slices?: Readonly<Record<string, OwnedSliceSize>>;
}

/* Whether a plan has anything to amend: a use case it leaves unresolved, a flow past the capacity or a flow too large for one author. */
export function needsAmendment(unresolved: readonly UseCaseCandidate[], amendment: PlanAmendment): boolean {
  return unresolved.length > 0 || (amendment.notAdmitted?.length ?? 0) > 0 || (amendment.oversize?.length ?? 0) > 0;
}

/*
 * The one amendment request the lead is asked, assembled from the registered sections: the candidates its plan leaves unresolved
 * (with the fact that refuses a drop), the flows not admitted and the flows too large, and what a plan must do with each. The shape
 * of the answer is the lead's role prompt.
 */
export function assembleReplanRequest(redaction: RedactionPort, unresolved: readonly UseCaseCandidate[], refused: NonNullable<PlanCoverage["refused"]> = [], amendment: PlanAmendment = {}): AssembledPrompt {
  const refusals = new Map(refused.map((r) => [r.candidate.id, { basis: r.basis, why: r.why }]));
  return assembleDefs(
    REPLAN_SECTIONS,
    {
      unresolved,
      refusals,
      ...(amendment.slices ? { slices: amendment.slices } : {}),
      ...(amendment.capacity !== undefined ? { capacity: amendment.capacity } : {}),
      ...(amendment.admitted !== undefined ? { admitted: amendment.admitted } : {}),
      notAdmitted: amendment.notAdmitted ?? [],
      oversize: amendment.oversize ?? [],
      scrub: (text) => redaction.redact(text),
    },
    { separator: "\n" },
  );
}

export function renderReplanRequest(redaction: RedactionPort, unresolved: readonly UseCaseCandidate[], refused: NonNullable<PlanCoverage["refused"]> = [], amendment: PlanAmendment = {}): string {
  return assembleReplanRequest(redaction, unresolved, refused, amendment).text;
}
