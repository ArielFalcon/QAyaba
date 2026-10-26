/* The review phase of a run: the independent reviewer's rounds over a green run, and the re-measure of a coverage that an accepted regeneration made stale. */

import type { QaCase } from "@kernel/qa-case.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { correctionClassOf } from "@contexts/generation/domain/review-output.ts";
import { renderSpecChanges, sameReviewedSpecs, type ReviewSpecText } from "@contexts/generation/domain/review-fingerprint.ts";
import { detectArchetype } from "@contexts/cross-run-learning/domain/distill-rule.ts";
import type { SpecRoot } from "../../../../../shared-infrastructure/spec-path-confinement.ts";
import { precheckSpecsAgainstDom } from "../../../domain/deterministic-review-precheck.ts";
import { citedSpec, filterReviewFindings } from "../../../domain/review-finding-filter.service.ts";
import { verifyRebuttals, findingKey } from "../../../domain/review-rebuttals.service.ts";
import { MAX_REVIEW_ROUNDS, reviewAction } from "../../../domain/review-action.ts";
import type { ReviewPort } from "../../ports/index.ts";
import { end, goto, type StepOutcome } from "../run-flow.ts";
import { throwIfAborted } from "../abort.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import type { ReviewSession, RunState } from "../run-state.ts";
import { liveExecutionOptions, executeAccepted, validateAccepted } from "./execute.steps.ts";
import { closedLoopSignal, contractFindingText, correctThroughLead, regenerateByLead } from "./generation-services.ts";
import { resolveTested } from "./fix-loop.steps.ts";
import { addReviewStats, annotateReviewPhase, newReviewTally, readReviewedSpecs, rebuttalEvidence, recordReviewDecision } from "./review-services.ts";

type Result = Promise<StepOutcome<RunState>>;

/* A context run's product is the architecture map, not tests: there is nothing for a test reviewer to judge, and a verdict it cannot give would turn a clean pass into an Issue. */
export const reviewsTests = (ctx: WorkspaceRunContext): boolean => ctx.cfg.needsReview && ctx.input.mode !== "context";

/* Also gated on generating: a regression run never invokes the reviewer (nothing new to judge; decide()'s !generating branch already wins). */
export const reviewsRun = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean =>
  state.execution.run.verdict === "pass" && reviewsTests(ctx) && state.classification.generating;

/* What the terminal exits of the review know about the run so far. */
async function exitFactsOf(state: Readonly<RunState>, ctx: WorkspaceRunContext) {
  const { trail, services } = ctx;
  const { diff, intent } = state.classification;
  return {
    static: state.execution.validation.ok,
    retries: state.execution.retries,
    rulesRetrieved: state.grounding.retrievedRuleIds,
    diffArchetypes: state.grounding.diffArchetypes,
    archetype: detectArchetype(diff, intent?.changedFiles ?? []),
    confinement: services.confinement.totals,
    tested: resolveTested(state),
    closedLoop: await closedLoopSignal(ctx),
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
 * MAX_REVIEW_ROUNDS = 2. parsed:false is a parse miss — fail closed immediately
 * without burning a regen round. Gate is approved && blockingCount === 0;
 * absent blockingCount defaults to corrections.length (fail-closed).
 * Last-round rejection is terminal. A regen that produces zero specs must not
 * inherit the generator's self-approval.
 *
 * This step only opens the review: what it judges, and the convergence context the rounds share. The rounds are the steps
 * review-round, review-correct and review-resolve; review-settle closes it.
 */
export async function reviewTests(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { generation } = ctx;
  const { run } = state.execution;
  const { existingSpecFiles: groundingExistingSpecFiles } = state.grounding;
  /*
   * The reviewer judges the specs this run delivered, not the whole executed suite: an existing
   * suite file that does not cover this change is context, never a wrong-objective correction.
   * The suite's paths travel separately, marked context-only in the review prompt.
   */
  const deliveredFiles = new Set(generation.delivered.map((d) => d.file));
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
  return goto("review-round", { review: { ...state.review, session }, loops: { ...state.loops, reviewRound: 0, reviewAttempt: 0 } });
}

/* One round: the reviewer judges the specs (or the pre-check or the unchanged-specs rule decides for it), and the verdict says what comes next. */
export async function reviewRound(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, cfg, signal, workspace, services, generation } = ctx;
  const { snapshotSuite } = services;
  const session = sessionOf(state);
  const { round } = session;
  const { diff: classificationDiff } = state.classification;
  const { retrievedRules } = state.grounding;
  const { run, retries } = state.execution;
  const { stats: reviewStats, existingSpecFiles } = session;
  /* Separate from generation enrichment: ReviewEnrichment has no sha/contextPack. domSnapshot is captured per review round on the current specs. */
  const baseReviewEnrichment = {
    runId: input.runId,
    ...(retrievedRules.length ? { learnedRules: retrievedRules } : {}),
  };
  const specRoot: SpecRoot = { mirrorDir: workspace.mirrorDir, specDir: workspace.specDir };
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
        console.error("[qa] WARNING: reviewer DOM grounding failed (non-fatal, review continues ungrounded):", err);
        session.reviewDomSnapshot = undefined;
      }
      session.lastReviewSpecsKey = specsKey;
    }
    throwIfAborted(signal);
  }
  const reviewDomSnapshot = session.reviewDomSnapshot;

  const reviewedSpecs = readReviewedSpecs(specRoot, reviewCases);
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
  let decidedBy: "model" | "precheck" | "unchanged" = "model";
  let roundRationale: string | undefined;

  if (unchangedSinceRejection) {
    session.reviewerApproved = false;
    reviewStats.skippedRounds++;
    reviewResult = {
      approved: false,
      corrections: previousRoundCorrections ?? [],
      blockingCount: session.previousRoundBlocking ?? previousRoundCorrections?.length ?? 0,
      rationale: "the specs are materially unchanged since the previous rejection, so that verdict stands",
      parsed: true,
    };
    decidedBy = "unchanged";
    console.error("[qa] reviewer: the specs did not change since the last rejection (comments/whitespace only) — the previous verdict stands without a second model round.");
    deps.observer?.onEvent({
      type: "log.line",
      level: "info",
      text: "[qa] reviewer: no material spec change since the last rejection; the previous corrections stand (no second model review)",
    });
  } else {
    /*
     * Deterministic first look at the reviewer's own evidence: an asserted literal or selector
     * the captured page contradicts is a blocking false positive, provable without a model. It
     * fails open on any uncertainty; the model reviewer still runs whenever it finds nothing.
     */
    const precheckFindings = precheckSpecsAgainstDom({ specs: reviewedSpecs, domSnapshot: reviewDomSnapshot });
    if (precheckFindings.length > 0) {
      session.reviewerApproved = false;
      reviewStats.preCheckRejects++;
      roundRationale = `the captured DEV page contradicts ${precheckFindings.length} assertion(s) in the specs (deterministic check)`;
      reviewResult = {
        approved: false,
        corrections: precheckFindings.map((finding) => finding.correction),
        blockingCount: precheckFindings.length,
        rationale: roundRationale,
        parsed: true,
      };
      decidedBy = "precheck";
      console.error(`[qa] reviewer pre-check: ${precheckFindings.length} clear contradiction(s) between the specs and the captured DOM — rejecting without a model round.`);
      for (const finding of precheckFindings) console.error(`[qa] reviewer pre-check: ${finding.correction}`);
    } else {
      const specChanges = previousRoundSpecs
        ? renderSpecChanges(previousRoundSpecs, reviewedSpecs)
        : "";
      reviewResult = await deps.review.review(workspace.specDir, reviewCases, classificationDiff, {
        ...baseReviewEnrichment,
        ...(previousRoundCorrections ? { priorCorrections: previousRoundCorrections } : {}),
        ...(specChanges ? { specChanges } : {}),
        ...(reviewDomSnapshot ? { domSnapshot: reviewDomSnapshot } : {}),
        ...(existingSpecFiles.length ? { existingSpecFiles } : {}),
        /* The run's own execution of the specs under review: the reviewer weighs a 5xx or a redirect against the test instead of guessing. */
        ...(reviewCases.length > 0 ? { executionEvidence: { verdict: run.verdict, cases: reviewCases } } : {}),
      });
      reviewStats.modelRounds++;
      addReviewStats(reviewStats, reviewResult.stats);
    }
  }
  reviewStats.rounds++;
  /*
   * The findings filter (D): only a finding that cites a contract clause, an execution or a DOM
   * fact this run can verify may block. Everything else is advisory telemetry, never sent to the
   * generator. The pre-check is the orchestrator's own deterministic evidence, so it is not a
   * reviewer finding and is never filtered. Gated by the master switch.
   */
  let filteredReviewFindings = 0;
  let advisoryReviewFindings = 0;
  /* The spec each verified finding's citation names, for routing it to the flow that owns that spec. */
  let blockingSpecs = new Map<string, string>();
  if (cfg.reviewLoopIntegrity && decidedBy === "model" && reviewResult.corrections.length > 0) {
    const findings = reviewResult.corrections.map((text, index) => ({
      text,
      severity: reviewResult.severities?.[index] ?? ("blocking" as const),
      ...(reviewResult.citations?.[index] ? { citation: reviewResult.citations[index]! } : {}),
    }));
    const filtered = filterReviewFindings(findings, {
      inScopeSpecs: new Set(reviewCases.map((c) => c.file ?? c.name)),
      executedSpecs: new Set(run.cases.map((c) => c.file).filter((file): file is string => !!file)),
    });
    blockingSpecs = new Map(findings.flatMap((f) => {
      const spec = f.citation ? citedSpec(f.citation.ref) : undefined;
      return spec !== undefined && filtered.blocking.includes(f.text) ? [[f.text, spec] as const] : [];
    }));
    filteredReviewFindings = filtered.dropped.length;
    advisoryReviewFindings = filtered.advisory.length;
    if (filtered.dropped.length > 0 || filtered.advisory.length > 0) {
      try {
        ctx.telemetry.counter("qayaba.review.filtered")(filtered.dropped.length, { "qayaba.app": input.app });
        ctx.telemetry.counter("qayaba.review.advisory")(filtered.advisory.length, { "qayaba.app": input.app });
      } catch (err) {
        console.error(`[telemetry] the filtered-findings counter could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    reviewResult = {
      ...reviewResult,
      /* Only a verified finding can keep the reviewer's rejection standing. */
      approved: filtered.blocking.length === 0,
      corrections: filtered.blocking,
      severities: filtered.blocking.map(() => "blocking" as const),
      citations: filtered.blocking.map(() => undefined),
      blockingCount: filtered.blocking.length,
    };
  }
  const reviewedBlocking = reviewResult.blockingCount ?? reviewResult.corrections.length;
  if (!reviewResult.unavailable) reviewStats.blocking = reviewedBlocking;
  const reviewOutcome = reviewResult.unavailable ? "unavailable" : reviewResult.parsed === false ? "parse-miss" : reviewResult.approved && reviewedBlocking === 0 ? "approved" : "rejected";
  const correctionClass = reviewedBlocking > 0 ? correctionClassOf(reviewResult.corrections) : "none";
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
    corrections: reviewResult.corrections,
    filtered: filteredReviewFindings,
    advisory: advisoryReviewFindings,
    rationale: reviewResult.rationale,
    durationMs: reviewResult.stats?.durationMs,
  });
  /*
   * A reviewer that could not be reached judged nothing: that is not a rejection, so it must not open an
   * Issue on a green run. The run ends as a persisted infra-error under its own class, with no PR and no Issue.
   */
  if (reviewResult.unavailable) {
    annotateReviewPhase(ctx, reviewStats, session.lastCorrectionClass, "unavailable");
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
    console.error("[qa] executedRed override: the executed run was red — reviewer approval overridden fail-closed (round 0, known-red spec, no regeneration).");
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
    session.finalReviewerCorrections = gateApproves ? [] : reviewResult.corrections;
  }
  if (next !== "correct") return goto("review-settle", { loops: { ...state.loops, reviewRound: round } });
  deps.observer?.onStep("retry", `reviewer-correction round ${round + 1}/${MAX_REVIEW_ROUNDS}`);
  session.previousRoundCorrections = reviewResult.corrections;
  session.previousRoundBlocking = reviewedBlocking;
  session.previousRoundSpecs = reviewedSpecs;
  session.previousRoundCaseCount = reviewCases.length;
  session.current = {
    reviewResult,
    decidedBy,
    blockingSpecs,
    snapshot: await snapshotSuite(),
    deliveredBefore: generation.delivered,
    regen: undefined,
    changedSpecFiles: [],
    changedSupportFiles: [],
    outcome: undefined,
    contractFeedback: undefined,
  };
  return goto("review-correct", { execution: { ...state.execution, retries: retries + 1 }, loops: { ...state.loops, reviewRound: round, reviewAttempt: 0 } });
}

/*
 * One correction attempt, with the turn's bytes accepted or given back. A round the contract refuses is sent back
 * once with the violations as facts (A-2b): the generator learns the bound the run holds it to inside the run,
 * and the retry spends no DEV time because the contract is checked before validation and execution. The bound is
 * per round, so the review loop's own round budget still caps the whole phase.
 */
export async function reviewCorrect(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { input, signal, trail, workspace, services, generation } = ctx;
  const { acceptance, integrityCounters, runDeadlinePort, suiteChangedFiles, acceptanceScope } = services;
  const { closedLoop } = trail;
  const session = sessionOf(state);
  const cur = session.current;
  if (!cur) throw new Error("a review correction ran before its round was judged");
  const attempt = state.loops.reviewAttempt;
  let { acceptanceCalls } = state.coverage;
  /* A refused attempt's files were restored, so its delivery must not survive into the next one. */
  generation.delivered = cur.deliveredBefore;
  const pass = trail.coordinatedPass;
  const { reviewResult, blockingSpecs, contractFeedback } = cur;
  const regen = pass
    ? await correctThroughLead(state, ctx, pass, [
        ...reviewResult.corrections.map((text) => ({ text, ...(blockingSpecs.has(text) ? { spec: blockingSpecs.get(text)! } : {}) })),
        ...(contractFeedback ?? []).map((v) => ({ text: contractFindingText(v), spec: v.file })),
      ], signal)
    : await regenerateByLead(state, ctx, signal, {
        reviewCorrections: reviewResult.corrections,
        ...(contractFeedback ? { contractFeedback } : {}),
      });
  await services.confinement.enforce();
  const changed = await suiteChangedFiles(cur.snapshot, regen.specs);
  cur.regen = regen;
  cur.changedSpecFiles = acceptanceScope(changed);
  cur.changedSupportFiles = changed.filter((file) => !file.endsWith(".spec.ts"));
  cur.outcome = undefined;
  if (regen.specs.length === 0) return goto("review-resolve");
  const outcome = await acceptance.accept({
    specDir: workspace.specDir,
    changedSpecFiles: cur.changedSpecFiles,
    namespace: `${input.runId}-acc${acceptanceCalls++}`,
    snapshot: cur.snapshot,
    ...(closedLoop ? { closedLoop } : {}),
    deadline: runDeadlinePort,
    validate: validateAccepted(ctx),
    execute: executeAccepted(ctx),
  });
  cur.outcome = outcome;
  const coverage = { ...state.coverage, acceptanceCalls };
  /* mutation-scope:begin contract-feedback-round */
  const refusedWithViolations = outcome.kind === "rejected" && !!outcome.violations?.length;
  if (reviewAction({ after: "attempt", refusedWithViolations, retried: attempt }) === "correct" && outcome.kind === "rejected") {
  /* mutation-scope:end contract-feedback-round */
    /* The refused attempt is one rejected regeneration, even though the round goes on to answer it. */
    integrityCounters.rejected += 1;
    cur.contractFeedback = outcome.violations;
    return goto("review-correct", { coverage, loops: { ...state.loops, reviewAttempt: attempt + 1 } });
  }
  return goto("review-resolve", { coverage });
}

/* The correction is over: what the generator answered to the findings is settled, and its specs stand only once accepted. */
export async function reviewResolve(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { input, cfg, workspace, services, generation } = ctx;
  const { integrityCounters, snapshotPort } = services;
  const session = sessionOf(state);
  const cur = session.current;
  if (!cur || !cur.regen) throw new Error("a review correction was resolved before it ran");
  const { reviewResult, decidedBy, regen, snapshot, deliveredBefore, changedSpecFiles, changedSupportFiles, outcome } = cur;
  const { stats: reviewStats } = session;
  let { run } = state.execution;
  let { acceptedRegenAfterMeasure } = state.coverage;
  /*
   * A rebuttal answers a reviewer finding; the deterministic pre-check is the orchestrator's own evidence and is
   * never rebuttable, so only a model round's findings are open to one. A verified rebuttal withdraws its finding;
   * one the run cannot check leaves the finding standing and is remembered as what the generator refused.
   */
  const rebuttals = cfg.reviewLoopIntegrity && decidedBy === "model" ? (regen.rebuttals ?? []) : [];
  const settled = rebuttals.length > 0
    ? verifyRebuttals(rebuttals, reviewResult.corrections, rebuttalEvidence(ctx, run.cases, rebuttals))
    : { withdrawn: [], disputed: [] };
  const withdrawn = new Set(settled.withdrawn.map(findingKey));
  const outstanding = reviewResult.corrections.filter((finding) => !withdrawn.has(findingKey(finding)));
  if (rebuttals.length > 0) {
    reviewStats.rebuttals += rebuttals.length;
    reviewStats.rebuttalWithdrawn += settled.withdrawn.length;
    /* Observe-only: a rebuttal is recorded with what the orchestrator made of it, and never changes a verdict by itself. */
    try {
      ctx.telemetry.counter("qayaba.review.rebuttal")(settled.withdrawn.length, { "qayaba.app": input.app, "qayaba.review.rebuttal.outcome": "withdrawn" });
      ctx.telemetry.counter("qayaba.review.rebuttal")(settled.disputed.length, { "qayaba.app": input.app, "qayaba.review.rebuttal.outcome": "disputed" });
    } catch (err) {
      console.error(`[telemetry] the rebuttal counter could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (regen.specs.length === 0) {
    /* A regen that produced no reviewable specs must not inherit the generator's self-approval; whatever its turn wrote is put back. */
    const restored = [...new Set([...changedSpecFiles, ...changedSupportFiles])];
    if (restored.length > 0) {
      await snapshotPort.restore(workspace.specDir, snapshot, restored.filter((file) => !snapshot.files.has(file)));
    }
    generation.delivered = deliveredBefore;
    /* Every blocking finding withdrawn with evidence, and no new bytes: the reviewed bytes stand approved. */
    const allWithdrawn = reviewResult.corrections.length > 0 && outstanding.length === 0;
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
      return end("review-disputed", { disputed: settled.disputed, passedCases: session.reviewCases.filter((c) => c.status === "pass").length, ...(await exitFactsOf(state, ctx)) });
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
   * The regenerated specs stand only once they execute green (or reuse a proof): they went through the same
   * acceptance as the coverage regen. Never let unaccepted bytes stand.
   */
  const next = reviewAction({ after: "acceptance", accepted: outcome?.kind === "accepted" });
  if (outcome?.kind === "accepted" && next === "judge") {
    integrityCounters.acceptances += 1;
    if (outcome.executedSpecs.length === 0) integrityCounters.proofReused += 1;
    acceptedRegenAfterMeasure = true;
    const changedSet = new Set(changedSpecFiles);
    const realCases = outcome.execution?.cases ?? [];
    if (realCases.length > 0) {
      /* Replace the changed files' cases with the acceptance execution's real cases; unchanged files keep theirs. */
      run = { ...run, cases: [...run.cases.filter((c) => !changedSet.has(c.file ?? c.name)), ...realCases] };
      session.reviewCases = [...realCases, ...session.reviewCases.filter((c: QaCase) => !changedSet.has(c.file ?? c.name))];
    }
    /* Proof reuse executed nothing: the existing cases already describe the bytes on disk. */
    session.round += 1;
    return goto("review-round", {
      execution: { ...state.execution, run },
      coverage: { ...state.coverage, acceptedRegenAfterMeasure },
      loops: { ...state.loops, reviewRound: session.round, reviewAttempt: 0 },
    });
  }
  generation.delivered = deliveredBefore;
  session.reviewerApproved = false;
  session.finalReviewerCorrections = reviewResult.corrections;
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
          skippedRounds: reviewStats.skippedRounds,
          correctionClass: reviewerApproved ? "none" : correctionClassOf(finalReviewerCorrections),
          ...(reviewStats.rebuttals > 0 ? { rebuttals: { received: reviewStats.rebuttals, withdrawn: reviewStats.rebuttalWithdrawn } } : {}),
        },
      },
    },
  };
}

/* The measurement predates the bytes an accepted regeneration wrote: only a per-commit measurement of a green run can go stale. */
export const remeasuresStaleCoverage = (state: Readonly<RunState>): boolean =>
  state.execution.run.verdict === "pass" && state.coverage.coverageMeasured && state.coverage.acceptedRegenAfterMeasure;

/*
 * The coverage this run measured is stale when an accepted regeneration followed it. Under enforce, one whole-suite measured
 * execution before decide refreshes it (the coverage regeneration's own run counts when it is the last accepted one, so this
 * never runs twice); under signal the prior measurement is reused and marked stale. A measured execution that ends red is the
 * run's verdict: a red suite is never published.
 */
export async function remeasureStaleCoverage(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, cfg, trail, telemetry, workspace } = ctx;
  const { run } = state.execution;
  if (cfg.coveragePolicyMode === "enforce") {
    const finalNamespace = `${input.runId}-coverage-final`;
    const measuredRun = await deps.execution.execute(workspace.specDir, { ...liveExecutionOptions(ctx), namespace: finalNamespace });
    const finalRun = { verdict: measuredRun.verdict, cases: measuredRun.cases, logs: run.logs };
    if (measuredRun.verdict !== "pass") return { update: { execution: { ...state.execution, run: finalRun } } };
    const baselineCases = measuredRun.cases.filter((c) => c.status === "pass").map((c) => c.name);
    const finalSignal = await deps.objectiveSignal.measure(
      BlastRadius.of(input.sha, state.classification.intent?.changedFiles ?? []),
      workspace.specDir,
      state.classification.diff,
      baselineCases,
      { namespace: finalNamespace },
    );
    trail.coverageStatus = finalSignal.status;
    const { valueScore, mutantCount, killedCount } = state.coverage;
    return {
      update: {
        execution: { ...state.execution, run: finalRun },
        coverage: {
          ...state.coverage,
          coverageRatio: finalSignal.ratio,
          coverageStatus: finalSignal.status,
          blocksPublish: deps.objectiveSignal.blocks(finalSignal.status),
          /* The oracle measured again on the delivered bytes: its score describes what is on disk now. */
          valueScore: finalSignal.valueScore ?? valueScore,
          mutantCount: finalSignal.mutantCount ?? mutantCount,
          killedCount: finalSignal.killedCount ?? killedCount,
          valueStale: false,
          acceptedRegenAfterMeasure: false,
        },
      },
    };
  }
  if (cfg.coveragePolicyMode !== "signal") return;
  let valueStale = state.coverage.valueStale;
  /* A measured value score is reused for the record and marked stale; it never blocks. */
  if (state.coverage.valueScore !== null) {
    valueStale = true;
    try {
      telemetry.counter("qayaba.value.stale")(1, { "qayaba.app": input.app });
    } catch (err) {
      console.error(`[telemetry] the stale-value counter could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    telemetry.counter("qayaba.coverage.stale")(1, { "qayaba.app": input.app });
  } catch (err) {
    console.error(`[telemetry] the stale-coverage counter could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
  return { update: { coverage: { ...state.coverage, coverageStale: true, valueStale } } };
}

/* The coordinated pass is kept only for the reviewer's corrections: once the review is over, or did not run, nothing can correct through it, and its sessions, workspaces and loops are released. Nothing when the run held none. */
export async function releaseCoordinatedPass(_state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  await ctx.host.closeCoordinatedPass();
}
