/*
 * One finished run's RunEvaluationEvidence, derived from what the run recorded: its record, its outcome row, its agent turns, its span
 * ledger and its spec snapshots. What the engine decided at run time (a reviewer was due, the coverage decision and policy, the limit that
 * fired) is read back from the run's columns, never recomputed from the app's current configuration, so a regrade today grades the run as
 * it was. Where a fact was never recorded the evidence says so (undefined or null) and the graders stay silent. Pure: the history reads
 * belong to the caller, which hands them over as `EvidenceSources`.
 */
import type { BundleMutationEvidence, RunEvaluationEvidence } from "../domain/run-evaluation-evidence.ts";
import type { UseCaseReference } from "../domain/use-case-reference.ts";
import type { EvidenceSources } from "../domain/evidence-sources.ts";
import type { ObservedDifference } from "@kernel/observed-difference.ts";
import { planEvidenceOf } from "../domain/plan-evidence.ts";
import { deliveredSpecNames, deliveredSpecsOf, specCountsOf } from "../domain/spec-evidence.ts";
import { causalOf, contextOf, limitIntentOf, runSpecCallsOf, sidekickReportsOf, stepIntentsOf, survivorsOf } from "../domain/span-evidence.ts";
import { referenceEvidenceOf } from "./reference-evidence.ts";

const COVERAGE_STATUSES = ["pass", "fail", "unknown"] as const;

export interface EvidenceContext {
  /* The labelled use cases of the apps, against which a plan's candidates are set. */
  readonly references: readonly UseCaseReference[];
  /* The agent name of the reviewer in the roster: the turns of that agent are the reviewer's. */
  readonly reviewerAgent: string;
}

export function assembleRunEvidence(sources: EvidenceSources, context: EvidenceContext): RunEvaluationEvidence {
  const { runId, record, facts, outcome, spans, turns, snapshots } = sources;
  const finished = record.status === "done" && record.verdict !== undefined;
  const verdict = record.verdict ?? null;
  const furthestPhase = sources.phases?.furthestPhase ?? null;

  const specs = specCountsOf(record, snapshots, furthestPhase);
  const g = outcome?.gateSignals;
  const plan = planEvidenceOf(sources.plan, record);
  const reference = referenceEvidenceOf(context.references, record, plan);
  const coverageStatus = COVERAGE_STATUSES.find((c) => c === facts?.coverageStatus);

  return {
    runId,
    ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
    sha: record.sha,
    app: record.app,
    mode: record.mode,
    finished,
    cancelled: facts?.cancelled === true,
    verdict,
    errorClass: outcome?.errorClass ?? null,
    decision: facts?.decision ?? null,
    furthestPhase,
    specs,
    reviewerTurns: turns.length === 0 ? undefined : turns.filter((t) => t.role === context.reviewerAgent).length,
    reviewRequired: facts?.reviewRequired ?? undefined,
    ...(outcome?.adjudication ? { adjudication: { class: outcome.adjudication.class, confidence: outcome.adjudication.confidence } } : {}),
    signals: g
      ? {
          static: g.static,
          reviewerApproved: g.reviewerApproved,
          coverageStatus,
          coverageMode: facts?.coverageMode ?? undefined,
          catalogGateFailClosed: g.catalogGateFailClosed,
          droppedRejections: g.reviewer?.droppedRejections,
          coverageRatio: g.coverageRatio ?? undefined,
          branchCoverage: g.branchCoverage,
          bundleMutation: g.bundleMutation ? bundleMutationEvidence(g.bundleMutation) : undefined,
          survivors: survivorsOf(spans),
          survivorClosure: g.survivorClosure ? { judged: g.survivorClosure.judged, closed: g.survivorClosure.closed } : undefined,
          flakyTriage: g.flakyTriage,
          lessons: g.lessons ? { delivered: g.lessons.delivered?.length ?? 0, dataStateFailures: g.lessons.dataStateFailures?.reduce((sum, p) => sum + p.count, 0), scopes: [...new Set((g.lessons.delivered ?? []).map((d) => d.scope))].sort(), failuresByPage: g.lessons.dataStateFailures, specPages: g.lessons.specPages } : undefined,
          routeAvailability: g.routeAvailability ? { unavailable: g.routeAvailability.unavailable, byClass: g.routeAvailability.byClass } : undefined,
          reviewer: g.reviewer ? { approved: g.reviewer.approved, rounds: g.reviewer.rounds, modelRounds: g.reviewer.modelRounds } : undefined,
          causal: causalOf(g.causal),
          defects: g.defects ? { found: g.defects.found } : undefined,
        }
      : undefined,
    limit: facts?.limitFired ? { fired: facts.limitFired, role: facts.limitRole ?? undefined, intent: limitIntentOf(spans, facts.limitRole ?? undefined) } : undefined,
    limits: facts?.limits ? facts.limits.map(({ fired, role, scope }) => ({ fired, role, scope })) : undefined,
    stepIntents: stepIntentsOf(spans),
    context: contextOf(spans, turns, snapshots),
    plan,
    ...(reference ? { reference } : {}),
    runSpecCalls: runSpecCallsOf(spans),
    deliveredSpecs: deliveredSpecsOf(deliveredSpecNames(record, snapshots), snapshots, record),
    sidekickReports: sidekickReportsOf(spans),
    finishedAt: outcome?.at ?? record.at,
  };
}

/*
 * The bundle mutation signal as the grader reads it: each judged survivor's observation says whether a test could see what the mutation
 * moved (`moved`), that nothing moved (an equivalent mutant) or that nothing was compared (no evidence either way, `moved` absent
 * included). A run that recorded no survivor to leave out keeps the judged count alone.
 */
function bundleMutationEvidence(signal: { applied: number; killed: number; survived?: readonly { readonly moved?: ObservedDifference }[] }): BundleMutationEvidence {
  const survivors = signal.survived;
  if (!survivors || survivors.length === 0) return { applied: signal.applied, killed: signal.killed };
  const moved = survivors.filter((s) => s.moved?.kind === "moved").length;
  const unmoved = survivors.filter((s) => s.moved?.kind === "unmoved").length;
  return { applied: signal.applied, killed: signal.killed, survivors: { moved, unmoved, unobserved: survivors.length - moved - unmoved } };
}
