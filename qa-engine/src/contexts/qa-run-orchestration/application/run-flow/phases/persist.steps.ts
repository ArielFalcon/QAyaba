/* The closing of a run: the outcome derived and saved, what the outcome teaches the learning loop, and the result the run returns. */

import { detectArchetype } from "@contexts/cross-run-learning/domain/distill-rule.ts";
import { learningGates } from "../../../domain/helpers/learning-gates.ts";
import type { RunQaResult } from "../../run-qa.use-case.ts";
import type { StepResult } from "../run-flow.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import type { RunState } from "../run-state.ts";
import { closedLoopSignal } from "./generation-services.ts";
import { decidedOf, reviewerApprovedForOutcomeOf } from "./decide.steps.ts";
import { DETERMINISTIC_SELECTOR_BLOCKS } from "./execute.steps.ts";

type Result = Promise<StepResult<RunState, RunQaResult>>;

/* The signals the persisted outcome and the returned result report alike: what the run's tools, integrity checks and staleness came to. */
function sharedSignals(state: Readonly<RunState>, ctx: WorkspaceRunContext, loopSignal: Awaited<ReturnType<typeof closedLoopSignal>>) {
  const { agentBrowser } = ctx.trail;
  const { integrityCounters, intentLock, intentState } = ctx.services;
  const { coverageStale, valueStale } = state.coverage;
  return {
    ...(loopSignal ? { closedLoop: loopSignal } : {}),
    ...(agentBrowser?.signals() ? { agentBrowser: agentBrowser.signals() } : {}),
    ...(coverageStale ? { coverage: { stale: true } } : {}),
    ...(valueStale ? { value: { stale: true } } : {}),
    ...(integrityCounters.acceptances > 0 || integrityCounters.rejected > 0 || integrityCounters.capHit
      ? { integrity: { ...integrityCounters } }
      : {}),
    ...(intentState.clauses > 0 || intentState.violations > 0
      ? {
          intent: {
            mode: intentLock.mode,
            violations: intentState.violations,
            wouldReject: intentState.wouldReject,
            clauses: intentState.clauses,
            opaque: intentState.opaque,
            opacityHigh: intentState.opacityHigh,
          },
        }
      : {}),
  };
}

/* Derive errorClass/valueScore once for both the persisted outcome and the returned result. */
export async function persistOutcome(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, ends, services } = ctx;
  const { decision, isContextCleanPass } = decidedOf(state);
  const { run, retries, validation } = state.execution;
  const { coverageRatio, valueScore, mutantCount, killedCount, branchCoverage, bundleMutation, branchCases } = state.coverage;
  const { finalReviewerCorrections, reviewerSignal, missingCases } = state.review;
  const { retrievedRuleIds, diffArchetypes, blastRadiusSignal, serviceLinks, contractDrift, crossRepoImpact } = state.grounding;
  const { preExecAmbiguityCatches, catalogGateInWindow, catalogGateAdvisory, catalogGateFailClosed } = state.generation;
  const { publishOutcome } = state.publication;
  const loopSignal = await closedLoopSignal(ctx);
  /* Thread the review loop's real final-round corrections into errorClass derivation. */
  const errorClass = ends.deriveErrorClass(decision.verdict, coverageRatio, valueScore, finalReviewerCorrections, {
    ...(state.fixLoop.devNotRenderedConclusive ? { preconditionFailed: true } : {}),
  });
  if (isContextCleanPass) return { update: { persisted: { errorClass, loopSignal, mainlineOutcome: undefined } } };
  const mainlineOutcome = ends.toRunOutcome(decision, run.cases, retries, coverageRatio, errorClass, {
    staticOk: validation.ok,
    reviewerApproved: reviewerApprovedForOutcomeOf(state),
    valueScore,
    /* Real oracle counts when threaded; absent (never a fabricated 0) when the oracle never measured. */
    mutantCount,
    killedCount,
    ...(branchCoverage ? { branchCoverage } : {}),
    ...(bundleMutation ? { bundleMutation } : {}),
    ...(branchCases ? { branchCases } : {}),
    ...(missingCases.length ? { missingCases } : {}),
    reviewerCorrections: finalReviewerCorrections,
    ...(reviewerSignal !== undefined ? { reviewer: reviewerSignal } : {}),
    /* Publish outcome string — never fabricated when publish() was not called. */
    ...(publishOutcome !== undefined ? { note: publishOutcome } : {}),
    /* Rule ids on the mainline persist only. Other exits omit them. */
    ...(retrievedRuleIds.length ? { rulesRetrieved: retrievedRuleIds } : {}),
    ...(diffArchetypes ? { diffArchetypes } : {}),
    /* Real pre-exec counters, not a hardcoded 0. */
    preExecAmbiguityCatches,
    deterministicSelectorBlocks: DETERMINISTIC_SELECTOR_BLOCKS,
    catalogGateInWindow,
    catalogGateAdvisory,
    catalogGateFailClosed,
    /*
     * structuralSignalBytes is gated on a non-empty render (empty is not "0 bytes").
     * serviceLinksCount/contractDriftCount are gated on the resolver being wired,
     * so 0 means "ran, found none", distinct from unwired.
     */
    ...(blastRadiusSignal ? { structuralSignalBytes: Buffer.byteLength(blastRadiusSignal, "utf8") } : {}),
    ...(deps.serviceLinks
      ? { serviceLinksCount: serviceLinks.length, contractDriftCount: contractDrift.length }
      : {}),
    /*
     * impactedLinksCount is gated on the result, not the collaborator's presence:
     * a same-repo run stays undefined (never ran), not a fabricated 0.
     */
    ...(crossRepoImpact ? { crossRepoImpactedCount: crossRepoImpact.impactedLinks.length } : {}),
    logs: run.logs,
    adjudicationClass: state.fixLoop.lastAdjudicatorVerdict?.class,
    /* Merged confinement across every enforce() this run made. Omitted when never wired. */
    ...(services.confinement.totals !== undefined ? { confinement: services.confinement.totals } : {}),
    ...sharedSignals(state, ctx, loopSignal),
  });
  await deps.runHistory.save(mainlineOutcome);
  return { update: { persisted: { errorClass, loopSignal, mainlineOutcome } } };
}

/* The run is learned from only when it persisted an outcome: a clean context pass produced a map, not tests. */
export const learnsFromRun = (state: Readonly<RunState>): boolean => state.persisted?.mainlineOutcome !== undefined;

export async function learnFromOutcome(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, cfg } = ctx;
  const { decision } = decidedOf(state);
  const mainlineOutcome = state.persisted!.mainlineOutcome!;
  const { offeredArchetypes } = state.grounding;
  const { diff: classificationDiff, intent: classificationIntent } = state.classification;
  const { coverageStatus } = state.coverage;
  /*
   * What this outcome may teach is decided in one place (learningGates). Off-path: never gates
   * the verdict. app_defect suppresses the fold so the flywheel never learns to weaken a test
   * that caught a real bug.
   */
  const learning = learningGates({
    stage: "mainline",
    mode: input.mode,
    verdict: decision.verdict,
    errorClass: mainlineOutcome.errorClass,
    isCode: cfg.isCode,
    adjudicationClass: mainlineOutcome.adjudication?.class,
  });
  if (learning.fold) {
    await deps.learning.fold(mainlineOutcome);
  }

  /*
   * Off-path. Deliberately NOT gated on the learning gates: app_defect is the
   * curriculum's strongest positive signal. Only the mainline exit folds —
   * invalid/infra-error never executed a suite.
   */
  if (offeredArchetypes.length > 0) {
    await deps.curriculum?.fold({
      offered: offeredArchetypes,
      verdict: decision.verdict,
      ...(mainlineOutcome.adjudication?.class !== undefined ? { adjudicationClass: mainlineOutcome.adjudication.class } : {}),
      ...(coverageStatus !== undefined ? { coverageStatus } : {}),
    });
  }

  /*
   * Stricter than fold: no flaky verdict, and errorClass must be a real class that teaches
   * (a green pass must not mint a reflection rule). Fold-on-green is unchanged.
   * Fault-isolated in the adapter.
   */
  if (deps.reflector && learning.reflect) {
    /* reflect() is awaited inline so the persisted outcome includes the back-fill before the run closes. */
    const reflectStartedAt = Date.now();
    /* Archetype from classificationDiff; undefined outside diff mode — never fabricated. */
    const archetype = detectArchetype(classificationDiff, classificationIntent?.changedFiles ?? []);
    await deps.reflector.reflect(ctx.ends.toReflectionInput(mainlineOutcome, archetype));
    const reflectMs = Date.now() - reflectStartedAt;
    deps.observer?.onEvent({
      type: "log.line",
      level: "info",
      text: `[qa] reflect() for run ${mainlineOutcome.runId} took ${reflectMs}ms`,
    });
  }

  /* Same gate as reflect, so processAudit and reflector stay independently optional. */
  if (deps.processAudit && learning.reflect) {
    /* Audit duration on the existing log.line channel. */
    const auditStartedAt = Date.now();
    await deps.processAudit.audit(mainlineOutcome);
    const auditMs = Date.now() - auditStartedAt;
    deps.observer?.onEvent({
      type: "log.line",
      level: "info",
      text: `[qa] processAudit.audit() for run ${mainlineOutcome.runId} took ${auditMs}ms`,
    });
  }
}

/* The last step of the table: every run that gets here ends with the decision, its error class and the signals the run gathered. */
export async function finishRun(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps } = ctx;
  const { decision, isContextCleanPass } = decidedOf(state);
  const { errorClass, loopSignal, mainlineOutcome } = state.persisted!;
  const { run, retries, validation } = state.execution;
  const { coverageRatio, valueScore } = state.coverage;
  const { reviewerSignal } = state.review;
  const { preExecAmbiguityCatches, catalogGateInWindow, catalogGateAdvisory, catalogGateFailClosed } = state.generation;
  const { publishOutcome } = state.publication;
  const reviewerApprovedForOutcome = reviewerApprovedForOutcomeOf(state);
  deps.observer?.onStep("done");
  return {
    end: {
      decision,
      errorClass,
      ...(mainlineOutcome ? { outcome: mainlineOutcome } : {}),
      /* Same publish outcome on the returned result for callers with no history read-back. */
      ...(publishOutcome !== undefined ? { note: publishOutcome } : {}),
      /* A clean context pass never persists, so the returned result must not report retrieved rules either. */
      rulesRetrieved: isContextCleanPass ? [] : state.grounding.retrievedRuleIds,
      gateSignals: {
        /* Clean context pass reports static:false — nothing was genuinely persisted. */
        static: isContextCleanPass ? false : validation.ok,
        coverageRatio,
        valueScore,
        /* Clean context pass omits reviewerApproved — nothing was genuinely persisted. */
        ...(!isContextCleanPass && reviewerApprovedForOutcome !== undefined ? { reviewerApproved: reviewerApprovedForOutcome } : {}),
        ...(!isContextCleanPass && reviewerSignal !== undefined ? { reviewer: reviewerSignal } : {}),
        retries,
        preExecAmbiguityCatches,
        deterministicSelectorBlocks: DETERMINISTIC_SELECTOR_BLOCKS,
        catalogGateInWindow,
        catalogGateAdvisory,
        catalogGateFailClosed,
        ...sharedSignals(state, ctx, loopSignal),
      },
      cases: run.cases,
      logs: run.logs,
    },
  };
}
