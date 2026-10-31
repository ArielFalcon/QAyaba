/*
 * The labelled use cases reachable on dev for the change, each with whether a candidate of the plan names one of its routes (a
 * candidate's page is a route template; `namesTemplatePage` lets a renamed parameter match), and the candidates that match no labelled
 * use case. Undefined without a reference for the change, without a dev use case, or when the plan kept its candidates without their pages.
 */
import { namesTemplatePage } from "@contexts/generation/application/index.ts";
import type { PlanEvidence, ReferenceEvidence } from "../domain/run-evaluation-evidence.ts";
import { referenceFor, type UseCaseReference } from "../domain/use-case-reference.ts";

export function referenceEvidenceOf(references: readonly UseCaseReference[], run: { app: string; sha: string }, plan: PlanEvidence | undefined): ReferenceEvidence | undefined {
  const change = referenceFor(references, run.app, run.sha);
  if (!change || !plan || plan.candidates.some((c) => c.pages === undefined)) return undefined;
  const dev = change.useCases.filter((u) => u.reachability === "dev");
  if (dev.length === 0) return undefined;
  const pages = plan.candidates.map((c) => c.pages ?? []);
  const names = (routes: readonly string[]): boolean => pages.some((candidatePages) => candidatePages.some((page) => routes.some((route) => namesTemplatePage(page, route))));
  const unlabelled = pages.filter((candidatePages) => !change.useCases.some((u) => candidatePages.some((page) => u.routes.some((route) => namesTemplatePage(page, route))))).length;
  return { useCases: dev.map((u) => ({ id: u.id, named: names(u.routes) })), unlabelledCandidates: unlabelled };
}
