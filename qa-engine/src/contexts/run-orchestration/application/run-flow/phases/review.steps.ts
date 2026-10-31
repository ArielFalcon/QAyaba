/* The review phase of a run: the independent reviewer's rounds over a green run, and the re-measure of a coverage that an accepted regeneration made stale. */

import { levelOfEffect } from "@kernel/ports/logger.port.ts";
import { engineLog } from "@kernel/ports/process-logger.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { hasGreenBytes } from "@kernel/run-verdict.ts";
import { correctionClassOf, findingTexts } from "@contexts/generation/application/index.ts";
import { renderSpecChanges, sameReviewedSpecs, type ReviewSpecText } from "@contexts/generation/application/index.ts";
import type { SpecRoot } from "@kernel/ports/spec-files.port.ts";
import { precheckSpecsAgainstDom } from "@contexts/generation/application/index.ts";
import { resolveSpecReference, specRelDirOf } from "@kernel/spec-path.ts";
import { ambientPinRef } from "@kernel/page-data-read.ts";
import { ambientPinsOf } from "../ambient-data-state.ts";
import { citedSpec, filterReviewFindings, identifyFindings, takeMissingCases, type DropReason } from "../../../domain/review-finding-filter.service.ts";
import { namedRebuttals, verifyRebuttals } from "../../../domain/review-rebuttals.service.ts";
import { MAX_REVIEW_ROUNDS } from "../../../domain/derive-cycle-backstop.ts";
import { reviewAction } from "../../../domain/review-action.ts";
import type { ReviewPort } from "@contexts/generation/application/index.ts";
import { end, goto, type StepOutcome } from "../run-flow.ts";
import { throwIfAborted } from "../abort.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import { REVIEW_DECISION_EFFECT, runOf, type ReviewDecidedBy, type ReviewSession, type RunState } from "../run-state.ts";
import { acceptedRegeneration, addRetries, remeasured, rollbackDelivered, withAcceptanceCalls, withRun } from "../reducers.ts";
import { liveExecutionOptions, executeAccepted, validateAccepted } from "./execute.steps.ts";
import { reviewRequired } from "../../../domain/review-required.ts";
import { acceptanceNamespace } from "../../../domain/acceptance-namespace.ts";
import { closedLoopSignal, correctionBudgetSpent, correctThroughLead, mayCorrectThroughLead, regenerateByAuthor } from "./generation-services.ts";
import { CORRECTION_ORIGIN, type CorrectionFinding } from "@contexts/coordination/application/index.ts";
import { resolveTested } from "./fix-loop.steps.ts";
import { reviewChangeViewOf } from "../review-change.ts";
import { branchCoverageOf, changeCoverageOf, coverageNotMeasured, measuredByOptions, rerunBudgetOf, runMeasurement, traceAcceptedFiles, withMeasuredBy } from "./coverage.steps.ts";
import { addDroppedRejection, addReviewStats, annotateReviewPhase, greenSpecFiles, newReviewTally, readReviewedSpecs, rebuttalEvidence, recordReviewDecision } from "./review-services.ts";
import { pathOnly } from "@kernel/route-availability.ts";
import { dataContradictionRefs } from "@kernel/data-contradiction.ts";
import { isRealPass } from "@kernel/case-proof.ts";

type Result = Promise<StepOutcome<RunState>>;

/* A context run's product is the architecture map, not tests: there is nothing for a test reviewer to judge, and a verdict it cannot give would turn a clean pass into an Issue. */
export const reviewsTests = (ctx: Pick<WorkspaceRunContext, "cfg" | "input">): boolean => reviewRequired({ needsReview: ctx.cfg.needsReview, mode: ctx.input.mode });

/* Also gated on generating: a regression run never invokes the reviewer (nothing new to judge; decide()'s !generating branch already wins). */
export const reviewsRun = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean =>
  hasGreenBytes(runOf(state).verdict) && reviewsTests(ctx) && state.classification.generating;

/* A review of a run that is not a pass (a flaky one) is advice: the run is quarantined whatever it concludes, so it never ends the run. */
const advisoryReview = (session: ReviewSession): boolean => session.finalRunVerdict !== "pass";

/* What the terminal exits of the review know about the run so far. */
async function exitFactsOf(state: Readonly<RunState>, ctx: WorkspaceRunContext) {
  const { trail, services } = ctx;
  return {
    static: state.execution.validation.ok,
    retries: state.execution.retries,
    confinement: services.confinement.totals,
    tested: resolveTested(state),
    closedLoop: await closedLoopSignal(state, ctx),
    agentBrowser: trail.agentBrowser?.signals(),
  };
}

const sessionOf = (state: Readonly<RunState>): ReviewSession => {
  const session = state.review.session;
  if (!session) throw new Error("a review step ran without a review session");
  return session;
};

/* The review steps run only while a session is open: the entry opens it, the settle step closes it. */
export const reviewInProgress = (state: Readonly<RunState>): boolean => state.review.session !== undefined;

/*
 * MAX_REVIEW_ROUNDS bounds the rounds. parsed:false is a parse miss — fail closed immediately
 * without burning a regen round. Gate is approved && blockingCount === 0;
 * absent blockingCount defaults to corrections.length (fail-closed).
 * Last-round rejection is terminal. A regen that produces zero specs must not
 * inherit the generator's self-approval.
 *
 * This step only opens the review: what it judges, and the convergence context the rounds share. The rounds are the steps
 * review-round, review-correct and review-resolve; review-settle closes it.
 */
export async function reviewTests(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const run = runOf(state);
  const { existingSpecFiles: groundingExistingSpecFiles } = state.grounding;
  /*
   * The reviewer judges the specs this run delivered, not the whole executed suite: an existing
   * suite file that does not cover this change is context, never a wrong-objective correction.
   * The suite's paths travel separately, marked context-only in the review prompt.
   */
  const deliveredFiles = new Set(state.generation.delivered.map((d) => d.file));
  const existingSpecFiles = [...new Set([...(groundingExistingSpecFiles ?? []), ...run.cases.map((c) => c.file ?? c.name)])]
    .filter((file) => !deliveredFiles.has(file));
  const session: ReviewSession = {
    round: 0,
    /* Capture executedRed's input before the rounds reassign `run`: the verdict the review was entered with is the one that decides it. */
    finalRunVerdict: run.verdict,
    reviewCases: run.cases.filter((c) => deliveredFiles.has(c.file ?? c.name)),
    existingSpecFiles,
    reviewerApproved: true,
    /* Stays [] when the review loop never runs — never fabricated. */
    finalReviewerCorrections: [],
    /* The reviewer's missing cases, each once across the rounds. */
    missingCases: [],
    /* The arms no test ran describe the bytes under review until the review accepts a regeneration of its own. */
    armsCurrent: state.coverage.untakenArmsCurrent && state.coverage.untakenArms.length > 0,
    previousRoundCorrections: undefined,
    /* The blocking count that produced the previous rejection, so a skipped round reports it unchanged. */
    previousRoundBlocking: undefined,
    previousRoundSpecs: undefined,
    previousRoundCaseCount: 0,
    stats: newReviewTally(),
    lastReviewOutcome: undefined,
    lastCorrectionClass: undefined,
    reviewDomSnapshot: undefined,
    /* Sentinel undefined so round 0 always captures — a "" initial would collide with an empty reviewCases key and skip round 0. */
    lastReviewSpecsKey: undefined,
    current: undefined,
  };
  return goto("review-round", { review: { ...state.review, session }, loops: { ...state.loops, reviewRound: 0 } });
}

/* One round: the reviewer judges the specs (or the pre-check or the unchanged-specs rule decides for it), and the verdict says what comes next. */
export async function reviewRound(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, cfg, signal, workspace, services } = ctx;
  const { snapshotSuite } = services;
  const session = sessionOf(state);
  const { round } = session;
  const { diff: classificationDiff } = state.classification;
  const run = runOf(state);
  const { stats: reviewStats, existingSpecFiles } = session;
  /* Separate from generation enrichment: ReviewEnrichment has no sha/contextPack. domSnapshot is captured per review round on the current specs. */
  const baseReviewEnrichment = {
    runId: input.runId,
  };
  const specRoot: SpecRoot = services.specRoot;
  /* The cases that checked a page only as DEV served it empty, read from the specs as they stand for this round: what an `ambient` citation names. */
  const ambientPins = ambientPinsOf(state, ctx);
  const reviewCases = session.reviewCases;
  const previousRoundSpecs = session.previousRoundSpecs;
  const previousRoundCorrections = session.previousRoundCorrections;
  /* Absent port: snapshot stays undefined (fail-open). Capture must not throw. */
  if (deps.reviewDomGrounding) {
    const specsForReview = reviewCases.map((c) => c.file ?? c.name);
    const specsKey = [...specsForReview].sort().join(",");
    if (specsKey !== session.lastReviewSpecsKey) {
      try {
        session.reviewDomSnapshot = await deps.reviewDomGrounding.capture(workspace.specDir, specsForReview, signal);
      } catch (err) {
        /* Abort during capture stops the run, not an ungrounded review round. */
        throwIfAborted(signal);
        engineLog.error("[qa] WARNING: reviewer DOM grounding failed (non-fatal, review continues ungrounded):", { error: err });
        session.reviewDomSnapshot = undefined;
      }
      session.lastReviewSpecsKey = specsKey;
    }
    throwIfAborted(signal);
  }
  const reviewDomSnapshot = session.reviewDomSnapshot;

  const reviewedSpecs = readReviewedSpecs(services.specFiles, specRoot, reviewCases);
  const specsReadable = reviewedSpecs.length === reviewCases.length && reviewedSpecs.length > 0;
  /*
   * The previous rejection stands when the new specs are materially the same: a round that
   * only changed comments cannot resolve a blocking correction, and paying a model to say so
   * twice is waste. Only judged when every case is readable, so a spec the reader cannot see
   * never silently skips its review.
   */
  const unchangedSinceRejection =
    previousRoundSpecs !== undefined &&
    specsReadable &&
    session.previousRoundCaseCount === reviewCases.length &&
    sameReviewedSpecs(previousRoundSpecs, reviewedSpecs);

  let reviewResult: Awaited<ReturnType<ReviewPort["review"]>>;
  let decidedBy: ReviewDecidedBy = "model";
  let roundRationale: string | undefined;

  if (unchangedSinceRejection) {
    session.reviewerApproved = false;
    reviewStats.skippedRounds++;
    reviewResult = {
      approved: false,
      findings: (previousRoundCorrections ?? []).map((text) => ({ text, severity: "blocking" as const })),
      blockingCount: session.previousRoundBlocking ?? previousRoundCorrections?.length ?? 0,
      rationale: "the specs are materially unchanged since the previous rejection, so that verdict stands",
      parsed: true,
    };
    decidedBy = "unchanged";
    const unchangedLevel = levelOfEffect(REVIEW_DECISION_EFFECT.unchanged);
    engineLog[unchangedLevel]("[qa] reviewer: the specs did not change since the last rejection (comments/whitespace only) — the previous verdict stands without a second model round.");
    deps.observer?.onEvent({
      type: "log.line",
      level: unchangedLevel,
      text: "[qa] reviewer: no material spec change since the last rejection; the previous corrections stand (no second model review)",
    });
  } else {
    /*
     * Deterministic first look at the reviewer's own evidence: an asserted literal or selector
     * the captured page contradicts is a blocking false positive, provable without a model. It
     * fails open on any uncertainty; the model reviewer still runs whenever it finds nothing.
     */
    /* A spec file whose every case passed on DEV on the bytes under review resolved its positive assertions there: the capture, which can differ in viewport, session, locale or location, does not overrule the run. */
    const provenGreenFiles = greenSpecFiles(reviewCases);
    const precheckFindings = precheckSpecsAgainstDom({ specs: reviewedSpecs, domSnapshot: reviewDomSnapshot, provenGreenFiles });
    if (reviewDomSnapshot) reviewStats.preCheckSkippedProven += reviewedSpecs.filter((spec) => provenGreenFiles.has(spec.file)).length;
    if (precheckFindings.length > 0) {
      session.reviewerApproved = false;
      reviewStats.preCheckRejects++;
      roundRationale = `the captured DEV page contradicts ${precheckFindings.length} assertion(s) in the specs (deterministic check)`;
      reviewResult = {
        approved: false,
        findings: precheckFindings.map((finding) => ({ text: finding.correction, severity: "blocking" as const })),
        blockingCount: precheckFindings.length,
        rationale: roundRationale,
        parsed: true,
      };
      decidedBy = "precheck";
      const precheckLevel = levelOfEffect(REVIEW_DECISION_EFFECT.precheck);
      engineLog[precheckLevel](`[qa] reviewer pre-check: ${precheckFindings.length} clear contradiction(s) between the specs and the captured DOM — rejecting without a model round.`);
      for (const finding of precheckFindings) engineLog[precheckLevel](`[qa] reviewer pre-check: ${finding.correction}`);
    } else {
      const specChanges = previousRoundSpecs
        ? renderSpecChanges(previousRoundSpecs, reviewedSpecs)
        : "";
      /* On a run with a plan, the reviewer judges the change by flow under review instead of the whole diff; absent, the whole diff. */
      const changeView = reviewChangeViewOf({
        diff: classificationDiff ?? "",
        candidates: state.grounding.candidates,
        flows: state.generation.flowCandidates,
        specsUnderReview: reviewCases.map((c) => c.file ?? c.name),
        specRelDir: specRelDirOf(specRoot),
        decisions: state.grounding.changedDecisions,
      });
      reviewResult = await deps.review.review(workspace.specDir, reviewCases, classificationDiff, {
        ...baseReviewEnrichment,
        ...(previousRoundCorrections ? { priorCorrections: previousRoundCorrections } : {}),
        ...(specChanges ? { specChanges } : {}),
        ...(reviewDomSnapshot ? { domSnapshot: reviewDomSnapshot } : {}),
        ...(existingSpecFiles.length ? { existingSpecFiles } : {}),
        ...(session.armsCurrent ? { untakenArms: state.coverage.untakenArms } : {}),
        ...(state.grounding.routeAvailability?.facts.length ? { routeAvailability: state.grounding.routeAvailability.facts } : {}),
        ...(state.grounding.dataContradictions?.facts.length ? { dataContradictions: state.grounding.dataContradictions.facts } : {}),
        ...(ambientPins.length ? { ambientDataPins: ambientPins } : {}),
        /* The run's own execution of the specs under review: the reviewer weighs a 5xx or a redirect against the test instead of guessing. */
        ...(reviewCases.length > 0 ? { executionEvidence: { verdict: run.verdict, cases: reviewCases } } : {}),
        ...(changeView ? { changeView } : {}),
      });
      reviewStats.modelRounds++;
      addReviewStats(reviewStats, reviewResult.stats);
    }
  }
  reviewStats.rounds++;
  /* The missing cases the reviewer cites from the arms no test ran are taken out first: recorded and shown, never a requirement or a gate. */
  if (decidedBy === "model" && reviewResult.findings.some((finding) => finding.citation?.kind === "arm")) {
    const cited = reviewResult.findings;
    const untakenArmRefs = session.armsCurrent ? new Set(state.coverage.untakenArms.map((u) => `${u.file}:${u.line}`)) : new Set<string>();
    const taken = takeMissingCases(cited, untakenArmRefs);
    for (const text of taken.missingCases) if (!session.missingCases.includes(text)) session.missingCases.push(text);
    const blocking = taken.rest.filter((f) => f.severity === "blocking").length;
    const restedOnArms = cited.some((f) => f.citation?.kind === "arm" && f.severity === "blocking");
    reviewResult = {
      ...reviewResult,
      /* A rejection that rested only on missing cases is no rejection. */
      approved: reviewResult.approved || (restedOnArms && blocking === 0),
      findings: taken.rest,
      blockingCount: blocking,
    };
  }
  /*
   * The findings filter (D): only a finding that cites a contract clause, an execution or a DOM
   * fact this run can verify may block. Everything else is advisory telemetry, never sent to the
   * generator. The pre-check is the orchestrator's own deterministic evidence, so it is not a
   * reviewer finding and is never filtered. A readable model round is judged even when it holds no
   * finding: a rejection with no verified blocking finding does not block. Every finding the round
   * admits gets its id here, and is named by it from then on.
   */
  let filteredReviewFindings = 0;
  let advisoryReviewFindings = 0;
  let droppedBlockingReasons: Partial<Record<DropReason, number>> = {};
  /* The spec each verified finding's citation names, by the finding's id, for routing it to the flow that owns that spec. */
  let blockingSpecs = new Map<string, string>();
  /* The round's findings as the run admitted them, each with its id. */
  let admitted: ReadonlyArray<{ readonly id: string; readonly text: string }>;
  const readableModelRound = reviewResult.parsed !== false && !reviewResult.unavailable;
  if (decidedBy === "model" && (reviewResult.findings.length > 0 || readableModelRound)) {
    const findings = reviewResult.findings;
    /* The scope and the citations meet in the suite-relative form: the spec directory an agent prefixes to a path is not part of the file's name. */
    const specRelDir = specRelDirOf(specRoot);
    const filtered = filterReviewFindings(findings, {
      specRelDir,
      inScopeSpecs: new Set(reviewCases.map((c) => c.file ?? c.name)),
      executedSpecs: new Set(run.cases.map((c) => c.file).filter((file): file is string => !!file)),
      availabilityRoutes: new Set((state.grounding.routeAvailability?.facts ?? []).flatMap((fact) => [pathOnly(fact.route), ...(fact.template !== undefined ? [pathOnly(fact.template)] : [])])),
      contradictionRefs: dataContradictionRefs(state.grounding.dataContradictions?.facts ?? []),
      ambientPinRefs: new Set(ambientPins.flatMap((pin) => {
        const spec = resolveSpecReference(pin.file, specRelDir);
        return spec !== undefined ? [ambientPinRef({ file: spec, test: pin.test })] : [];
      })),
    });
    blockingSpecs = new Map(filtered.blocking.flatMap((f) => {
      const spec = f.citation ? citedSpec(f.citation.ref, specRelDir) : undefined;
      return spec !== undefined ? [[f.id, spec] as const] : [];
    }));
    filteredReviewFindings = filtered.dropped.length;
    advisoryReviewFindings = filtered.advisory.length;
    droppedBlockingReasons = filtered.droppedBlocking;
    /* A rejection whose every blocking finding was dropped turns into an approval here: the run must be able to tell. Only the model's own rejection counts: an approval's blocking-severity notes were never a rejection. */
    if (!reviewResult.approved && filtered.blocking.length === 0 && Object.keys(filtered.droppedBlocking).length > 0) addDroppedRejection(reviewStats, filtered.droppedBlocking);
    if (filtered.dropped.length > 0 || filtered.advisory.length > 0) {
      try {
        ctx.telemetry.counter("qayaba.review.filtered")(filtered.dropped.length, { "qayaba.app": input.app });
        ctx.telemetry.counter("qayaba.review.advisory")(filtered.advisory.length, { "qayaba.app": input.app });
      } catch (err) {
        engineLog.error(`[telemetry] the filtered-findings counter could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    admitted = filtered.blocking;
    reviewResult = {
      ...reviewResult,
      /* Only a verified finding can keep the reviewer's rejection standing. */
      approved: filtered.blocking.length === 0,
      findings: filtered.blocking,
      blockingCount: filtered.blocking.length,
    };
  } else {
    const identified = identifyFindings(reviewResult.findings);
    admitted = identified;
    reviewResult = { ...reviewResult, findings: identified };
  }
  const corrections = findingTexts(reviewResult.findings);
  const reviewedBlocking = reviewResult.blockingCount ?? corrections.length;
  if (!reviewResult.unavailable) reviewStats.blocking = reviewedBlocking;
  const reviewOutcome = reviewResult.unavailable ? "unavailable" : reviewResult.parsed === false ? "parse-miss" : reviewResult.approved && reviewedBlocking === 0 ? "approved" : "rejected";
  const correctionClass = reviewedBlocking > 0 ? correctionClassOf(corrections) : "none";
  session.lastReviewOutcome = reviewOutcome;
  session.lastCorrectionClass = correctionClass;
  recordReviewDecision(ctx, {
    round: round + 1,
    outcome: reviewOutcome,
    decidedBy,
    correctionClass,
    blocking: reviewedBlocking,
    targets: [...new Set(reviewCases.map((c) => c.file ?? c.name))],
    existingSpecFiles,
    corrections,
    filtered: filteredReviewFindings,
    advisory: advisoryReviewFindings,
    droppedBlocking: droppedBlockingReasons,
    rationale: reviewResult.rationale,
    issues: reviewResult.issues ?? [],
    durationMs: reviewResult.stats?.durationMs,
  });
  /*
   * A reviewer that could not be reached judged nothing: that is not a rejection, so it must not open an
   * Issue on a green run. The run ends as a persisted infra-error under its own class, with no PR and no Issue.
   */
  if (reviewResult.unavailable) {
    annotateReviewPhase(ctx, reviewStats, session.lastCorrectionClass, "unavailable");
    /* A flaky run is quarantined whatever the reviewer says: a reviewer that could not be reached leaves it unapproved, not an infra-error. */
    if (advisoryReview(session)) {
      session.reviewerApproved = false;
      return goto("review-settle");
    }
    return end("reviewer-unavailable", { rationale: reviewResult.rationale, passedCases: reviewCases.length, ...(await exitFactsOf(state, ctx)) });
  }
  /*
   * A reviewer that sees a red spec must not approve it. Round-0-only: after
   * internal regen the spec is fresh and unexecuted. Dormant under the current
   * pass-only entry guard — defense in depth if review becomes reachable on fail.
   */
  const parsed = reviewResult.parsed !== false;
  const executedRed = parsed && round === 0 && session.finalRunVerdict === "fail";
  if (executedRed) {
    engineLog.error("[qa] executedRed override: the executed run was red — reviewer approval overridden fail-closed (round 0, known-red spec, no regeneration).");
  }
  const gateApproves = reviewResult.approved && reviewedBlocking === 0;
  const next = reviewAction({ after: "judgment", round, maxRounds: MAX_REVIEW_ROUNDS, unavailable: false, parsed, executedRed, gateApproves, unchangedSinceRejection });
  /* Do not set finalReviewerCorrections on parse-miss or executedRed exits (no real reviewer-authored text). */
  if (!parsed || executedRed) {
    session.reviewerApproved = false;
  } else {
    session.reviewerApproved = gateApproves;
    /*
     * Only a rejecting round's corrections become a learning/errorClass signal.
     * An approving round clears them, including its own advisory notes — otherwise
     * a passing run would derive a failure class.
     */
    session.finalReviewerCorrections = gateApproves ? [] : corrections;
  }
  if (next !== "correct") return goto("review-settle", { loops: { ...state.loops, reviewRound: round } });
  deps.observer?.onStep("retry", `reviewer-correction round ${round + 1}/${MAX_REVIEW_ROUNDS}`);
  session.previousRoundCorrections = corrections;
  session.previousRoundBlocking = reviewedBlocking;
  session.previousRoundSpecs = reviewedSpecs;
  session.previousRoundCaseCount = reviewCases.length;
  session.current = {
    reviewResult,
    decidedBy,
    findings: admitted.map(({ id, text }) => {
      const spec = blockingSpecs.get(id);
      return { id, text, ...(spec !== undefined ? { spec } : {}) };
    }),
    snapshot: await snapshotSuite(),
    deliveredBefore: state.generation.delivered,
    regen: undefined,
    changedSpecFiles: [],
    changedSupportFiles: [],
    outcome: undefined,
  };
  return goto("review-correct", { execution: addRetries(state.execution, 1), loops: { ...state.loops, reviewRound: round } });
}

/* One correction attempt, with the turn's bytes accepted or given back. */
export async function reviewCorrect(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { input, signal, trail, workspace, services } = ctx;
  const { acceptance, runDeadlinePort, suiteChangedFiles, acceptanceScope } = services;
  const session = sessionOf(state);
  const cur = session.current;
  if (!cur) throw new Error("a review correction ran before its round was judged");
  let { acceptanceCalls } = state.coverage;
  const pass = trail.coordinatedPass;
  const findings: CorrectionFinding[] = cur.findings;
  const { output: regen, leadCorrections } = !pass
    ? {
        output: await regenerateByAuthor(state, ctx, signal, { reviewCorrections: findings.map((finding) => finding.text) }),
        leadCorrections: 0,
      }
    : mayCorrectThroughLead(state, ctx)
      ? await correctThroughLead(state, ctx, pass, findings)
      : correctionBudgetSpent(ctx, pass, findings, CORRECTION_ORIGIN.REVIEW);
  await services.confinement.enforce();
  const changed = await suiteChangedFiles(cur.snapshot, regen.specs);
  cur.regen = regen;
  cur.changedSpecFiles = acceptanceScope(changed);
  cur.changedSupportFiles = changed.filter((file) => !file.endsWith(".spec.ts"));
  cur.outcome = undefined;
  const loops = { ...state.loops, leadCorrections: state.loops.leadCorrections + leadCorrections };
  if (regen.specs.length === 0) return goto("review-resolve", { loops });
  const outcome = await acceptance.accept({
    specDir: workspace.specDir,
    changedSpecFiles: cur.changedSpecFiles,
    namespace: acceptanceNamespace(input.runId, acceptanceCalls++),
    snapshot: cur.snapshot,
    prior: runOf(state),
    /* A turn that changed no file the specs import is accepted spec file by spec file. */
    independentSpecs: cur.changedSupportFiles.length === 0,
    deadline: runDeadlinePort,
    validate: validateAccepted(state, ctx),
    execute: executeAccepted(ctx),
  });
  cur.outcome = outcome;
  const coverage = withAcceptanceCalls(state.coverage, acceptanceCalls);
  return goto("review-resolve", { coverage, loops });
}

/* The correction is over: what the generator answered to the findings is settled, and its specs stand only once accepted. */
export async function reviewResolve(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { input, cfg, workspace, services } = ctx;
  const { integrityCounters, snapshotPort } = services;
  const session = sessionOf(state);
  const cur = session.current;
  if (!cur || !cur.regen) throw new Error("a review correction was resolved before it ran");
  const { decidedBy, regen, snapshot, deliveredBefore, changedSpecFiles, changedSupportFiles, outcome } = cur;
  const { stats: reviewStats } = session;
  let run = runOf(state);
  let coverage = state.coverage;
  /*
   * A rebuttal answers a reviewer finding; the deterministic pre-check is the orchestrator's own evidence and is
   * never rebuttable, so only a model round's findings are open to one. A verified rebuttal withdraws its finding;
   * one the run cannot check leaves the finding standing and is remembered as what the generator refused.
   */
  const answered = decidedBy === "model" ? (regen.rebuttals ?? []) : [];
  const roundFindings = cur.findings.map(({ id, text }) => ({ id, text }));
  const corrections = roundFindings.map((finding) => finding.text);
  /* A rebuttal names one finding of the round by its id; one that names none is unread, recorded, and withdraws nothing. */
  const named = namedRebuttals(answered, roundFindings);
  const rebuttals = named.rebuttals;
  const settled = rebuttals.length > 0
    ? verifyRebuttals(rebuttals, roundFindings, rebuttalEvidence(ctx, run.cases, rebuttals))
    : { withdrawn: [], disputed: [], unnamed: [] };
  const unread = named.unread.length + settled.unnamed.length;
  if (unread > 0) engineLog.warn(`[qa] review: ${unread} rebuttal(s) named no single finding of the round (an unknown id, or a repeated text no finding or several findings carry); they are not read and withdraw nothing.`);
  const withdrawn = new Set(settled.withdrawn);
  const outstanding = roundFindings.filter((finding) => !withdrawn.has(finding.id)).map((finding) => finding.text);
  if (answered.length > 0) {
    reviewStats.rebuttals += answered.length;
    reviewStats.rebuttalWithdrawn += settled.withdrawn.length;
    /* Observe-only: a rebuttal is recorded with what the orchestrator made of it, and never changes a verdict by itself. */
    try {
      ctx.telemetry.counter("qayaba.review.rebuttal")(settled.withdrawn.length, { "qayaba.app": input.app, "qayaba.review.rebuttal.outcome": "withdrawn" });
      ctx.telemetry.counter("qayaba.review.rebuttal")(settled.disputed.length, { "qayaba.app": input.app, "qayaba.review.rebuttal.outcome": "disputed" });
      if (unread > 0) ctx.telemetry.counter("qayaba.review.rebuttal")(unread, { "qayaba.app": input.app, "qayaba.review.rebuttal.outcome": "unread" });
    } catch (err) {
      engineLog.error(`[telemetry] the rebuttal counter could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (regen.specs.length === 0) {
    /* A regen that produced no reviewable specs must not inherit the generator's self-approval; whatever its turn wrote is put back. */
    const restored = [...new Set([...changedSpecFiles, ...changedSupportFiles])];
    if (restored.length > 0) {
      await snapshotPort.restore(workspace.specDir, snapshot, restored.filter((file) => !snapshot.files.has(file)));
    }
    rollbackDelivered(state, deliveredBefore);
    /* Every blocking finding withdrawn with evidence, and no new bytes: the reviewed bytes stand approved. */
    const allWithdrawn = corrections.length > 0 && outstanding.length === 0;
    const next = reviewAction({ after: "correction", produced: false, allWithdrawn, disputed: settled.disputed.length > 0 });
    if (next === "approve") {
      session.reviewerApproved = true;
      session.finalReviewerCorrections = [];
    } else if (next === "end-disputed") {
      /*
       * A verified finding survives while the generator's answer to it is a claim nobody can check. Correcting it
       * was possible and the turn delivered nothing, so opening an Issue would accuse a test the reviewer never
       * justified, and publishing would ignore the finding: the engine reports that it could not settle it.
       */
      /* A flaky run is quarantined whatever the reviewer says: a finding the run could not settle leaves it unapproved. */
      if (advisoryReview(session)) {
        session.reviewerApproved = false;
        return goto("review-settle");
      }
      return end("review-disputed", { disputed: settled.disputed, passedCases: session.reviewCases.filter(isRealPass).length, ...(await exitFactsOf(state, ctx)) });
    } else {
      session.reviewerApproved = false;
    }
    return goto("review-settle");
  }
  /* The surviving findings are the next round's convergence context: a withdrawn one is not raised again. */
  if (withdrawn.size > 0) {
    session.previousRoundCorrections = outstanding;
    session.previousRoundBlocking = outstanding.length;
  }
  /*
   * The regenerated specs stand only once they execute green: they went through the same
   * acceptance as the coverage regen. Never let unaccepted bytes stand.
   */
  const next = reviewAction({ after: "acceptance", accepted: outcome?.kind === "accepted" });
  if (outcome?.kind === "accepted" && next === "judge") {
    integrityCounters.acceptances += 1;
    if (outcome.executedSpecs.length === 0) integrityCounters.proofReused += 1;
    coverage = acceptedRegeneration(coverage);
    session.armsCurrent = false;
    /* A spec file the acceptance gave its prior bytes back keeps its prior delivery and cases: only the kept files are the turn's. */
    if (outcome.restored.length > 0) rollbackDelivered(state, deliveredBefore, outcome.restored);
    traceAcceptedFiles(ctx, CORRECTION_ORIGIN.REVIEW, { kept: outcome.kept.length, restored: outcome.restored.length });
    const keptSet = new Set(outcome.kept);
    const realCases = outcome.execution?.cases ?? [];
    /* The kept files' cases are the acceptance execution's, whatever it holds (a kept file the turn deleted has none); every other file keeps its own. */
    run = {
      ...run,
      cases: [...run.cases.filter((c) => !keptSet.has(c.file ?? c.name)), ...realCases],
      skippedTests: [...(run.skippedTests ?? []).filter((t) => !keptSet.has(t.file ?? t.name)), ...(outcome.execution?.skippedTests ?? [])],
    };
    session.reviewCases = [...realCases, ...session.reviewCases.filter((c: QaCase) => !keptSet.has(c.file ?? c.name))];
    session.round += 1;
    return goto("review-round", {
      execution: withRun(state.execution, run),
      coverage,
      loops: { ...state.loops, reviewRound: session.round },
    });
  }
  rollbackDelivered(state, deliveredBefore);
  if (outcome) traceAcceptedFiles(ctx, CORRECTION_ORIGIN.REVIEW, { kept: 0, restored: changedSpecFiles.length });
  session.reviewerApproved = false;
  session.finalReviewerCorrections = corrections;
  if (outcome?.kind === "cap") integrityCounters.capHit = true;
  else integrityCounters.rejected += 1;
  return goto("review-settle");
}

/* The review is over: its verdict, and what it cost, become the run's. */
export async function reviewSettle(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const session = sessionOf(state);
  const { stats: reviewStats, reviewerApproved, finalReviewerCorrections } = session;
  if (session.lastReviewOutcome !== undefined) annotateReviewPhase(ctx, reviewStats, session.lastCorrectionClass, session.lastReviewOutcome);
  return {
    update: {
      review: {
        session: undefined,
        reviewerApproved,
        /* A genuine review verdict overwrites generation's self-approval default. */
        reviewerApprovedForOutcome: reviewerApproved,
        finalReviewerCorrections,
        missingCases: session.missingCases,
        reviewerSignal: {
          rounds: reviewStats.rounds,
          modelRounds: reviewStats.modelRounds,
          approved: reviewerApproved,
          corrections: finalReviewerCorrections.length,
          blocking: reviewStats.blocking,
          durationMs: reviewStats.durationMs,
          promptBytes: reviewStats.promptBytes,
          outputTokens: reviewStats.metricsKnown.output ? reviewStats.outputTokens : null,
          costUsd: reviewStats.metricsKnown.cost ? reviewStats.costUsd : null,
          steps: reviewStats.metricsKnown.steps ? reviewStats.steps : null,
          preCheckRejects: reviewStats.preCheckRejects,
          ...(reviewStats.preCheckSkippedProven > 0 ? { preCheckSkippedProven: reviewStats.preCheckSkippedProven } : {}),
          skippedRounds: reviewStats.skippedRounds,
          correctionClass: reviewerApproved ? "none" : correctionClassOf(finalReviewerCorrections),
          ...(reviewStats.droppedRejections > 0 ? { droppedRejections: { rounds: reviewStats.droppedRejections, reasons: { ...reviewStats.droppedRejectionReasons } } } : {}),
          ...(reviewStats.rebuttals > 0 ? { rebuttals: { received: reviewStats.rebuttals, withdrawn: reviewStats.rebuttalWithdrawn } } : {}),
        },
      },
    },
  };
}

/* The measurement predates the bytes an accepted regeneration wrote: only a per-commit measurement of a run with green bytes (a pass, or a flaky run's retry) can go stale. */
export const remeasuresStaleCoverage = (state: Readonly<RunState>): boolean =>
  hasGreenBytes(runOf(state).verdict) && state.coverage.coverageMeasured && state.coverage.acceptedRegenAfterMeasure;

/*
 * The coverage this run measured is stale when an accepted regeneration followed it. Under enforce, one whole-suite execution before
 * decide judges the final bytes under the execution contract (it measures nothing), and one measurement execution of its passing tests
 * then measures them (the coverage regeneration's own run counts when it is the last accepted one, so this never runs twice); under
 * signal the prior measurement is reused and marked stale. A judging execution that ends red is the verdict of a passing run: a red
 * suite is never published. A flaky run keeps its flaky verdict. A measurement the time left cannot hold measures nothing: the coverage
 * is unknown and the run is held.
 */
export async function remeasureStaleCoverage(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, cfg, telemetry, workspace } = ctx;
  const run = runOf(state);
  if (cfg.coveragePolicyMode === "enforce") {
    const finalNamespace = `${input.runId}-coverage-final`;
    const judgedRun = await deps.execution.execute(workspace.specDir, { ...liveExecutionOptions(ctx), namespace: finalNamespace });
    /* A flaky run was unstable in this run, and that verdict stands: a final execution changes neither its verdict nor its cases, so it stays quarantined. One that ran green, even first time, is measured; one that ran red measures nothing and the measurement the run keeps is marked stale. The coverage block applies to the decision, never by replacing the verdict. */
    if (run.verdict === "flaky" && !hasGreenBytes(judgedRun.verdict)) {
      engineLog.warn(`[qa] coverage re-measure: the final execution of a flaky run ended ${judgedRun.verdict}; the flaky verdict stands and the kept measurement is marked stale.`);
      return { update: { coverage: { ...state.coverage, coverageStale: true } } };
    }
    const flakyStands = run.verdict === "flaky";
    const finalRun = flakyStands ? run : { verdict: judgedRun.verdict, cases: judgedRun.cases, logs: run.logs };
    if (judgedRun.verdict !== "pass" && !flakyStands) return { update: { execution: withRun(state.execution, finalRun) } };
    const purpose = ctx.services.runDeadlinePort.currentPurpose?.() ?? "review";
    const measuredBy = await runMeasurement(ctx, judgedRun.cases, `${finalNamespace}-measure`, purpose);
    if ("notRun" in measuredBy) {
      return { update: { execution: withRun(state.execution, finalRun), coverage: { ...coverageNotMeasured(remeasured(state.coverage), cfg.coveragePolicyMode, state.coverage.coverageMeasured), measuredBy } } };
    }
    const measured = measuredByOptions(measuredBy);
    const finalSignal = await deps.objectiveSignal.measure(
      BlastRadius.of(input.sha, state.classification.intent?.changedFiles ?? []),
      workspace.specDir,
      state.classification.diff,
      measured.baselineCases,
      {
        ...measured.opts,
        ...(state.grounding.candidates.length > 0 ? { candidates: state.grounding.candidates } : {}),
        ...(state.coverage.exclusions ? { exclusions: state.coverage.exclusions } : {}),
        /* Its mutation re-runs are the time of the purpose the run is in, estimated from the measurement, which ran under their conditions. */
        rerunBudget: rerunBudgetOf(ctx, purpose, measuredBy.cases),
      },
    );
    return {
      update: {
        execution: withRun(state.execution, finalRun),
        coverage: {
          ...remeasured(state.coverage),
          measuredBy,
          coverageRatio: finalSignal.ratio,
          coverageStatus: finalSignal.status,
          perCandidate: finalSignal.measurement?.perCandidate,
          branchCoverage: branchCoverageOf(finalSignal.measurement),
          uncovered: finalSignal.uncovered ?? [],
          untakenArms: finalSignal.untakenArms ?? [],
          untakenArmsCurrent: true,
          bundleMutation: finalSignal.bundleMutation ?? state.coverage.bundleMutation,
          mutantProofs: finalSignal.mutantProofs ?? [],
          changeCoverage: withMeasuredBy(changeCoverageOf(finalSignal.measurement), measuredBy),
          blocksPublish: deps.objectiveSignal.blocks(finalSignal.status),
        },
      },
    };
  }
  if (cfg.coveragePolicyMode !== "signal") return;
  try {
    telemetry.counter("qayaba.coverage.stale")(1, { "qayaba.app": input.app });
  } catch (err) {
    engineLog.error(`[telemetry] the stale-coverage counter could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
  return { update: { coverage: { ...state.coverage, coverageStale: true } } };
}

/* The coordinated pass is kept only for the reviewer's corrections: once the review is over, or did not run, nothing can correct through it, and its sessions, workspaces and loops are released. Nothing when the run held none. */
export async function releaseCoordinatedPass(_state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  await ctx.host.closeCoordinatedPass();
}
