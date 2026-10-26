/*
 * How a run that reached its decision ends: the part of `finalizeRun` for the reasons `decided` and `context-pass`. The effects run
 * in one declared order: record how a coordinated run came out, make the last confinement pass, capture what must outlive the
 * working copy (a context map, the accepted suite), publish what the decision calls for, prune the working copy once the git
 * write is done, save the run's record, learn from it and return the result. Each step of that order is a function below, so what
 * a decided run does is read in one place.
 */

import { detectArchetype } from "@contexts/cross-run-learning/application/index.ts";
import { isAccepted } from "../../domain/run-decision.service.ts";
import { learningGates } from "@contexts/cross-run-learning/application/index.ts";
import { reviewsTests } from "./phases/review.steps.ts";
import { reviewerApprovedForOutcomeOf, decidedOf } from "./phases/decide.steps.ts";
import { DETERMINISTIC_SELECTOR_BLOCKS } from "./phases/execute.steps.ts";
import { closedLoopSignal } from "./phases/generation-services.ts";
import { resolveTested } from "./phases/fix-loop.steps.ts";
import type { PublicationPort } from "../ports/index.ts";
import { deriveErrorClass, toReflectionInput, toRunOutcome } from "./outcome-assembly.ts";
import type { WorkspaceRunContext } from "./run-context.ts";
import type { RunQaResult } from "./run-types.ts";
import { runOf, type RunState } from "./run-state.ts";
import { PublicationFailedError, actionFor, carryOn } from "./failure-policy.ts";

export async function finalizeDecided(state: Readonly<RunState>, ctx: WorkspaceRunContext): Promise<RunQaResult> {
  await recordCoordinationOutcome(state, ctx);
  await ctx.services.confinement.enforce();

  ctx.trail.phases.enter("publish");
  await captureContextMap(state, ctx);
  if (keepsSuite(state, ctx)) await keepAcceptedSuite(state, ctx);

  let publishOutcome: string | undefined;
  if (decidedOf(state).decision.sideEffect !== "none") publishOutcome = await publishDecision(state, ctx);

  /* Once, after confinement and publish, so gc never races this run's git write. */
  await ctx.host.pruneMirror(ctx.workspace.mirrorDir);

  /* What the run went on past is said on its record beside what publication came to. */
  const note = [...state.degraded.map((d) => d.note), ...(publishOutcome !== undefined ? [publishOutcome] : [])].join("; ") || undefined;
  const persisted = await persistOutcome(state, ctx, note);
  if (persisted.mainlineOutcome) {
    ctx.trail.phases.enter("learn");
    await learnFromOutcome(state, ctx, persisted.mainlineOutcome);
  }
  return resultOf(state, ctx, persisted, note);
}

/* A coordinated run says how it ended: the verdict with the quality sampled at the same instant, and how many flows were handed back. */
async function recordCoordinationOutcome(state: Readonly<RunState>, ctx: WorkspaceRunContext): Promise<void> {
  const { deps, input, host, startedAt } = ctx;
  const { decision } = decidedOf(state);
  const coordinationSignal = host.coordination();
  if (!coordinationSignal || !deps.coordinationTelemetry) return;
  const { coverageRatio, valueScore } = state.coverage;
  const reviewerApprovedForOutcome = reviewerApprovedForOutcomeOf(state);
  /* Read from the same honest source as the persisted outcome: absent when no reviewer looked at this run. */
  const reviewOutcome =
    !reviewsTests(ctx) ? "skipped" as const
    : reviewerApprovedForOutcome === true ? "approved" as const
    : reviewerApprovedForOutcome === false ? "rejected" as const
    : "n/a" as const;
  deps.coordinationTelemetry.record({
    runId: input.runId,
    app: input.app,
    kind: "outcome",
    action: coordinationSignal.plan === "fanout" ? "delegate" : "direct",
    reason: `pipeline verdict=${decision.verdict}; flows ${coordinationSignal.delivered}/${coordinationSignal.flows} delivered${coordinationSignal.takeover ? "; the lead took over" : ""}`,
    finalOutcome: decision.verdict,
    reviewOutcome,
    /* Quality sampled at the same instant the outcome is stamped. */
    ...(coverageRatio !== undefined ? { coverageRatio } : {}),
    ...(valueScore !== null ? { valueScore } : {}),
    escalations: coordinationSignal.incomplete + (coordinationSignal.takeover ? 1 : 0),
    durationMs: Date.now() - startedAt,
    at: Date.now(),
  });
}

/*
 * A clean context-mode pass wrote the FE<->BE architecture map to the mirror's e2e/.qa/context.json. That file does not survive the
 * mirror's next `git checkout -f` + `git clean -fd`, so the orchestrator captures it into the durable store BEFORE publication, in
 * both shadow and non-shadow runs, whatever publish() then does with a context.json PR (including throwing). Off-path: a capture
 * fault is logged and never changes the verdict. A clean context pass neither persists nor folds: it produced a map, not tests.
 */
async function captureContextMap(state: Readonly<RunState>, ctx: WorkspaceRunContext): Promise<void> {
  const { deps, input, workspace } = ctx;
  if (!decidedOf(state).isContextCleanPass || !deps.contextMapCapture) return;
  try {
    await deps.contextMapCapture.capture(workspace.specDir, input.app, input.sha.toString());
  } catch (captureErr) {
    /* A git dir that is not the orchestrator's is a security refusal, however the capture was asked: it reaches the caller. */
    carryOn(captureErr);
    console.warn(
      `[qa] context-map capture failed (off-path; verdict unchanged): ${captureErr instanceof Error ? captureErr.message : String(captureErr)}`,
    );
  }
}

/*
 * An accepted run proved its suite, whatever happens to the pull request (and in shadow mode none is opened): the suite is kept
 * before publication, so the next run's checkout cannot wipe it. Off-path: a fault is logged and never changes the verdict.
 */
const keepsSuite = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean =>
  !!ctx.deps.suiteStore && state.setup.suiteRestored && isAccepted(decidedOf(state).evidence);

async function keepAcceptedSuite(state: Readonly<RunState>, ctx: WorkspaceRunContext): Promise<void> {
  const { deps, input, workspace, services, host } = ctx;
  const { authVerifiedSha256 } = state.execution;
  try {
    const kept = await deps.suiteStore!.capture({
      mirrorDir: workspace.mirrorDir,
      specDir: workspace.specDir,
      runId: input.runId,
      sha: input.sha.toString(),
      /* The ledger's own hashes: every file admitted is one whose green bytes this run holds. */
      executedGreen: new Map(Object.entries(state.proof)),
      ...(authVerifiedSha256 !== undefined ? { authVerifiedSha256 } : {}),
    });
    host.announceSuite(`[qa] suite store: kept ${kept.entries} file(s) (${kept.admitted} new or changed, ${kept.dropped} dropped${kept.skipped.length > 0 ? `, ${kept.skipped.length} left out` : ""})`, "info");
  } catch (captureErr) {
    carryOn(captureErr);
    host.announceSuite(`[qa] suite store capture failed (off-path; verdict unchanged): ${captureErr instanceof Error ? captureErr.message : String(captureErr)}`, "warn");
  }
}

/*
 * Every side-effect-bearing decision calls publish, not just "pr"; "none" is the only skip. This run's reviewerApproved and
 * blocksPublish ride along so a green-but-rejected run opens an Issue and an enforce coverage fail holds the PR. e2eChanged is
 * omitted (no computed source: do not fabricate). Cross-repo Issues file in triggerRepo; PRs still target the primary.
 */
async function publishDecision(state: Readonly<RunState>, ctx: WorkspaceRunContext): Promise<string> {
  const { deps, input, cfg, workspace, services } = ctx;
  const run = runOf(state);
  const { reviewerApproved } = state.review;
  const { lastAdjudicatorVerdict } = state.fixLoop;
  let published: Awaited<ReturnType<PublicationPort["publish"]>>;
  try {
    published = await deps.publication.publish({
      verdict: run.verdict,
      cases: run.cases,
      logs: run.logs,
      reviewerApproved,
      coverageBlocks: state.coverage.blocksPublish,
      ...(input.triggerRepo ? { issueRepo: input.triggerRepo } : {}),
      /* Adjudication is absent when FixLoop never engaged: never fabricated. */
      ...(lastAdjudicatorVerdict ? { adjudication: lastAdjudicatorVerdict } : {}),
      /* Real per-run mirrorDir + sha for the "pr" git-write. This is the only pr-capable call site. */
      mirrorDir: workspace.mirrorDir,
      sha: input.sha.toString(),
      /* tested omitted when empty. parentRunId only from /continue, never fabricated. Intra-run regens reuse this same input object. */
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      isCode: cfg.isCode,
      ...(resolveTested(state)?.length ? { tested: resolveTested(state) } : {}),
    });
  } catch (pubErr) {
    /* The verdict was decided before the port failed: the policy keeps it, and the run records and learns from it with the failure as its note. */
    const failure = new PublicationFailedError(
      `publication failed after verdict was decided (decided: ${run.verdict}, reviewerApproved: ${reviewerApproved}): ${pubErr instanceof Error ? pubErr.message : String(pubErr)}`,
      { cause: pubErr },
    );
    if (actionFor(failure, "publish").do !== "degrade") throw failure;
    console.error(`[qa] ${failure.message}`);
    return failure.message;
  }
  /*
   * Merge denylist reverts into gateSignals.confinement. Count only revertedDangerous toward dangerous: not every revert is a
   * secret leak. Absent revertedDangerous is treated as zero, never "everything is dangerous".
   */
  if (published.revertedDenylisted?.length) {
    services.confinement.add({
      strays: published.revertedDenylisted.length,
      dangerous: published.revertedDangerous?.length ?? 0,
      reverted: [...published.revertedDenylisted],
    });
  }
  return published.outcome;
}

/* What persisting derived: the error class and closed-loop signal both the record and the result report, and the record itself (absent for a clean context pass). */
interface Persisted {
  errorClass: string | null;
  loopSignal: Awaited<ReturnType<typeof closedLoopSignal>>;
  mainlineOutcome: ReturnType<typeof toRunOutcome> | undefined;
}

/* The signals the persisted outcome and the returned result report alike: what the run's tools, integrity checks and staleness came to. */
function sharedSignals(state: Readonly<RunState>, ctx: WorkspaceRunContext, loopSignal: Persisted["loopSignal"]) {
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
async function persistOutcome(state: Readonly<RunState>, ctx: WorkspaceRunContext, publishOutcome: string | undefined): Promise<Persisted> {
  const { deps, services } = ctx;
  const { decision, isContextCleanPass } = decidedOf(state);
  const { retries, validation } = state.execution;
  const run = runOf(state);
  const { coverageRatio, valueScore, mutantCount, killedCount } = state.coverage;
  const { finalReviewerCorrections, reviewerSignal } = state.review;
  const { retrievedRuleIds, diffArchetypes, blastRadiusSignal, serviceLinks, contractDrift, crossRepoImpact } = state.grounding;
  const { preExecAmbiguityCatches, catalogGateInWindow, catalogGateAdvisory, catalogGateFailClosed } = state.generation;
  const loopSignal = await closedLoopSignal(state, ctx);
  /* Thread the review loop's real final-round corrections into errorClass derivation. */
  const errorClass = deriveErrorClass(decision.verdict, coverageRatio, valueScore, finalReviewerCorrections, {
    ...(state.fixLoop.devNotRenderedConclusive ? { preconditionFailed: true } : {}),
    sandboxRefused: ctx.host.sandboxRefused(),
  });
  if (isContextCleanPass) return { errorClass, loopSignal, mainlineOutcome: undefined };
  const mainlineOutcome = toRunOutcome(ctx, decision, run.cases, retries, coverageRatio, errorClass, {
    staticOk: validation.ok,
    reviewerApproved: reviewerApprovedForOutcomeOf(state),
    valueScore,
    /* Real oracle counts when threaded; absent (never a fabricated 0) when the oracle never measured. */
    mutantCount,
    killedCount,
    reviewerCorrections: finalReviewerCorrections,
    ...(reviewerSignal !== undefined ? { reviewer: reviewerSignal } : {}),
    /* Publish outcome string, never fabricated when publish() was not called. */
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
     * structuralSignalBytes is gated on a non-empty render (empty is not "0 bytes"). serviceLinksCount/contractDriftCount are
     * gated on the resolver being wired, so 0 means "ran, found none", distinct from unwired.
     */
    ...(blastRadiusSignal ? { structuralSignalBytes: Buffer.byteLength(blastRadiusSignal, "utf8") } : {}),
    ...(deps.serviceLinks
      ? { serviceLinksCount: serviceLinks.length, contractDriftCount: contractDrift.length }
      : {}),
    /* impactedLinksCount is gated on the result, not the collaborator's presence: a same-repo run stays undefined (never ran), not a fabricated 0. */
    ...(crossRepoImpact ? { crossRepoImpactedCount: crossRepoImpact.impactedLinks.length } : {}),
    logs: run.logs,
    adjudicationClass: state.fixLoop.lastAdjudicatorVerdict?.class,
    /* Merged confinement across every enforce() this run made. Omitted when never wired. */
    ...(services.confinement.totals !== undefined ? { confinement: services.confinement.totals } : {}),
    ...sharedSignals(state, ctx, loopSignal),
  });
  await deps.runHistory.save(mainlineOutcome);
  return { errorClass, loopSignal, mainlineOutcome };
}

async function learnFromOutcome(state: Readonly<RunState>, ctx: WorkspaceRunContext, mainlineOutcome: NonNullable<Persisted["mainlineOutcome"]>): Promise<void> {
  const { deps, input, cfg } = ctx;
  const { decision } = decidedOf(state);
  const { offeredArchetypes } = state.grounding;
  const { diff: classificationDiff, intent: classificationIntent } = state.classification;
  const { coverageStatus } = state.coverage;
  /*
   * What this outcome may teach is decided in one place (learningGates). Off-path: never gates the verdict. app_defect
   * suppresses the fold so the flywheel never learns to weaken a test that caught a real bug.
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
   * Off-path. Deliberately NOT gated on the learning gates: app_defect is the curriculum's strongest positive signal. Only the
   * mainline exit folds: invalid/infra-error never executed a suite.
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
   * Stricter than fold: no flaky verdict, and errorClass must be a real class that teaches (a green pass must not mint a
   * reflection rule). Fold-on-green is unchanged. Fault-isolated in the adapter.
   */
  if (deps.reflector && learning.reflect) {
    /* reflect() is awaited inline so the persisted outcome includes the back-fill before the run closes. */
    const reflectStartedAt = Date.now();
    /* Archetype from classificationDiff; undefined outside diff mode, never fabricated. */
    const archetype = detectArchetype(classificationDiff, classificationIntent?.changedFiles ?? []);
    await deps.reflector.reflect(toReflectionInput(mainlineOutcome, archetype));
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

/* Every run that gets here ends with the decision, its error class and the signals the run gathered. */
function resultOf(state: Readonly<RunState>, ctx: WorkspaceRunContext, persisted: Persisted, publishOutcome: string | undefined): RunQaResult {
  const { deps } = ctx;
  const { decision, isContextCleanPass } = decidedOf(state);
  const { errorClass, loopSignal, mainlineOutcome } = persisted;
  const { retries, validation } = state.execution;
  const run = runOf(state);
  const { coverageRatio, valueScore } = state.coverage;
  const { reviewerSignal } = state.review;
  const { preExecAmbiguityCatches, catalogGateInWindow, catalogGateAdvisory, catalogGateFailClosed } = state.generation;
  const reviewerApprovedForOutcome = reviewerApprovedForOutcomeOf(state);
  deps.observer?.onStep("done");
  return {
    decision,
    errorClass,
    ...(mainlineOutcome ? { outcome: mainlineOutcome } : {}),
    /* Same publish outcome on the returned result for callers with no history read-back. */
    ...(publishOutcome !== undefined ? { note: publishOutcome } : {}),
    /* A clean context pass never persists, so the returned result must not report retrieved rules either. */
    rulesRetrieved: isContextCleanPass ? [] : state.grounding.retrievedRuleIds,
    gateSignals: {
      /* Clean context pass reports static:false: nothing was genuinely persisted. */
      static: isContextCleanPass ? false : validation.ok,
      coverageRatio,
      valueScore,
      /* Clean context pass omits reviewerApproved: nothing was genuinely persisted. */
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
  };
}
