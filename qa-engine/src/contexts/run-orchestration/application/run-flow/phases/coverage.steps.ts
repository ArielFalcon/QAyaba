/* The coverage phase of a run: the change-coverage measurement of a green execution and at most one regeneration at its gap: in enforce mode at the uncovered lines (with the arms no test ran), otherwise, with the branch cases on, at the arms no test ran. The mutants of the changed code that ran under a test and that no test noticed are part of that gap: the test reached the change and checked nothing. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { CORRECTION_ORIGIN, type CorrectionFinding, type CorrectionOrigin } from "@contexts/coordination/application/index.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { candidatesSeededBy } from "@kernel/change-map.ts";
import { hasGreenBytes } from "@kernel/run-verdict.ts";
import { isAllotmentSpentError } from "@kernel/run-deadline.ts";
import type { DeadlinePurpose } from "@kernel/deadline-purpose.ts";
import type { GenerationEnrichment } from "@contexts/generation/application/index.ts";
import { changedCodeFiles, isReadTrouble, renderBranchGap, renderCoverageGap, renderSurvivedMutants, rerunEstimateMs, rerunFits, survivorClosureOf, survivorFindings, survivorRechecks, testOfCase, testSupportFiles, unreachableByDesign, type BundleMutationResult, type CoverageExclusions, type CoverageMeasurement, type CoverageSignal, type CoverageSource, type MeasuredPages, type MutantRerun, type RerunBudget, type SurvivedMutant, type SurvivorClosure } from "@contexts/objective-signal/application/index.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { StepOutcome } from "../run-flow.ts";
import type { RunContext, WorkspaceRunContext } from "../run-context.ts";
import { runOf, type BranchCasesOutcome, type CoverageOutcome, type MeasuredDumps, type MeasurementOutcome, type RunState, type SpecBytes } from "../run-state.ts";
import { sha256Hex } from "@kernel/content-hash.ts";
import { MAX_SPEC_SOURCE_BYTES } from "@kernel/ports/spec-files.port.ts";
import { acceptedRegeneration, recordLimit, remeasured, rollbackDelivered, withAcceptanceCalls, withRun } from "../reducers.ts";
import { executeAccepted, validateAccepted } from "./execute.steps.ts";
import { regenerate, type EvidenceFinding } from "./generation-services.ts";
import { branchCasesAction, coverageRegenAction } from "../../../domain/coverage-regen.ts";
import { acceptanceNamespace } from "../../../domain/acceptance-namespace.ts";
import { isRealPass } from "@kernel/case-proof.ts";
import { ambientPinFindings, ambientRecordOf, type AmbientRecord } from "../ambient-data-state.ts";

type Result = Promise<StepOutcome<RunState>>;

/* A context run executes nothing (its pass is synthetic), so it has no coverage or value to measure. */
export const measuresCoverage = (state: Readonly<RunState>, ctx: RunContext): boolean => hasGreenBytes(runOf(state).verdict) && ctx.input.mode !== "context";

/* Why the measurement is passed over: a context run executes nothing, and a verdict with no green bytes has nothing to measure. */
export const coverageSkipReason = (state: Readonly<RunState>, ctx: WorkspaceRunContext): string => (ctx.input.mode === "context" ? "context-run" : "no-green-bytes");

/* The arms of the decisions on changed lines a measurement counted, and how many ran; undefined when it saw none. */
export const branchCoverageOf = (m: CoverageMeasurement | undefined): CoverageOutcome["branchCoverage"] =>
  m?.changedBranches !== undefined ? { changed: m.changedBranches, taken: m.takenBranches ?? 0 } : undefined;

/* The part of a measurement the run records beside its ratio; undefined when it measured nothing. A measurement that decides nothing because its evidence could not be read (no dump, or a read that ended in a fault) is recorded with that reason: an ending found only in a log line is not recorded. */
export function changeCoverageOf(m: CoverageMeasurement | undefined): CoverageOutcome["changeCoverage"] {
  if (!m) return undefined;
  if (m.unmeasured !== undefined) return isReadTrouble(m.unmeasured) ? { executableLines: 0, unmeasured: m.unmeasured } : undefined;
  return {
    executableLines: m.changedLines,
    ...(m.notExecutableLines !== undefined ? { notExecutableLines: m.notExecutableLines } : {}),
    ...(m.notLoadedFiles ? { notLoadedFiles: m.notLoadedFiles } : {}),
    ...(m.noCodeFiles ? { noCodeFiles: m.noCodeFiles } : {}),
    ...(m.unreachableByDesign ? { unreachableByDesign: m.unreachableByDesign } : {}),
    ...(m.testSupportFiles ? { testSupportFiles: m.testSupportFiles } : {}),
    ...(m.coveredByExecution !== undefined ? { coveredByExecution: m.coveredByExecution } : {}),
    ...(m.provenByMutation !== undefined ? { provenByMutation: m.provenByMutation } : {}),
    ...(m.armsProvenByMutation !== undefined ? { armsProvenByMutation: m.armsProvenByMutation } : {}),
    ...(m.evidenceLeftOut?.length ? { evidenceLeftOut: [...m.evidenceLeftOut] } : {}),
  };
}

/* Only a diff run on one repo measures a real per-commit coverage signal. */
const measuresPerCommit = (ctx: WorkspaceRunContext): boolean => ctx.input.mode === "diff" && !ctx.input.triggerRepo;

/* The step is announced only when this pass actually measures per commit; a pass that never measured does not emit it. */
export const announcesCoverage = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean => measuresCoverage(state, ctx) && measuresPerCommit(ctx);

export async function announceCoverage(_state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  ctx.deps.observer?.onStep("coverage");
}

/*
 * The changed files that are no gap of the suite, from the run's own facts: those only reached through routes the change made
 * unavailable (the grounding's change scope, its use cases and the route availability classification), then, of the rest, those
 * only test files import (the code graph's import edges). A fact that is missing or partial leaves the file counted; a graph that
 * cannot answer is said and leaves every file counted. Undefined when nothing is left out.
 */
export async function coverageExclusionsOf(state: Readonly<RunState>, ctx: WorkspaceRunContext): Promise<CoverageExclusions | undefined> {
  const { deps, input } = ctx;
  const diff = state.classification.diff;
  if (diff === undefined || diff === "" || input.triggerRepo) return undefined;
  const files = changedCodeFiles(diff);
  const byDesign = unreachableByDesign({ files, diff, scope: state.grounding.changeScope, candidates: state.grounding.candidates, facts: state.grounding.routeAvailability?.facts ?? [] });
  const decided = new Set(byDesign.map((e) => e.file));
  const undecided = files.filter((file) => !decided.has(file));
  let support: ReturnType<typeof testSupportFiles> = [];
  if (deps.codeGraph?.importersOf && undecided.length > 0) {
    const importers = await deps.codeGraph.importersOf(deps.codeGraphRepoDir ?? ctx.services.specRoot.mirrorDir, undecided);
    if (importers.ok) support = testSupportFiles(importers.value, decided);
    else engineLog.warn(`[qa] change-coverage: the code graph could not say who imports the changed files (${importers.error.reason}); none is taken for test support.`);
  }
  if (byDesign.length === 0 && support.length === 0) return undefined;
  engineLog.info(`[qa] change-coverage: left out as no gap of the suite: ${byDesign.length} file(s) only reached through routes the change made unavailable, ${support.length} test support file(s).`);
  return { unreachableByDesign: byDesign, testSupportFiles: support };
}

/*
 * The one measurement execution (RFC-0015): the green tests of the bytes `cases` judged (passed, or passed on a retry), run once more with coverage on and observed,
 * retries 0 and only those tests, under its own namespace. It judges nothing: the verdict stands whatever it does. It starts only when
 * the time `purpose` may still spend holds the time those cases took and the run's deadline has not fired, and Playwright's own global
 * timeout is the allowance, so it never runs past it. A measurement that did not start, could not run, or was cut before every test it
 * was given ran measured nothing.
 */
export async function runMeasurement(ctx: WorkspaceRunContext, cases: readonly QaCase[], namespace: string, purpose: DeadlinePurpose): Promise<MeasurementOutcome> {
  const passing = cases.filter(ranGreen);
  const specFiles = [...new Set(passing.flatMap((c) => (c.file ? [c.file] : [])))];
  const tests = [...new Set(passing.map((c) => testOfCase(c.name)))];
  const notRun = (why: string, time?: true): MeasurementOutcome => {
    engineLog.warn(`[qa] change-coverage: the measurement execution ${namespace} measured nothing (${why}); the coverage is unknown and the verdict stands`);
    return { notRun: true, tests: passing.length, ...(time ? { time } : {}) };
  };
  if (passing.length === 0 || specFiles.length === 0) return notRun("no passing test to measure");
  const budget = rerunBudgetOf(ctx, purpose, cases);
  if (budget.fired?.() === true) return notRun("the run's deadline has fired", true);
  const allowance = budget.allowance();
  const estimate = rerunEstimateMs(cases, specFiles, tests);
  if (!rerunFits(allowance, estimate)) return notRun(`it is estimated at ${estimate ?? "an unknown number of"} ms and the time left holds ${allowance} ms`, true);
  const files = specFiles.map((file): SpecBytes => ({ file, sha: bytesOf(ctx, file) }));
  const result = await ctx.deps.execution.execute(ctx.workspace.specDir, {
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    purpose: "measurement",
    namespace,
    coverage: true,
    observe: true,
    retries: 0,
    specFiles,
    tests,
    ...(allowance !== null ? { globalTimeoutMs: Math.max(1, Math.floor(allowance)) } : {}),
  });
  if (result.verdict === "infra-error") return notRun("it could not run");
  const byName = new Map(result.cases.map((c) => [c.name, c]));
  if (passing.some((c) => !byName.has(c.name))) return notRun("it was cut before every test it was given ran");
  const greenThere = (c: QaCase): boolean => isRealPass(byName.get(c.name)!);
  return {
    namespace,
    tests: passing.length,
    passed: passing.filter(greenThere).map((c) => c.name),
    baseline: passing.filter((c) => isRealPass(c) && greenThere(c)).map((c) => c.name),
    failedOnlyUnderMeasurement: passing.filter((c) => !greenThere(c)).map((c) => c.name),
    cases: result.cases.map((c) => ({ name: c.name, status: c.status, ...(c.file !== undefined ? { file: c.file } : {}), ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}), ...(c.expectedStatus !== undefined ? { expectedStatus: c.expectedStatus } : {}) })),
    ...(result.observations ? { observations: result.observations } : {}),
    files,
  };
}

/* The fingerprint of a spec file's bytes, read strictly; undefined when they cannot be read, which matches only bytes that could not be read either. */
function bytesOf(ctx: WorkspaceRunContext, file: string): string | undefined {
  try {
    const read = ctx.services.specFiles.readOwned(ctx.services.specRoot, file, MAX_SPEC_SOURCE_BYTES);
    return "bytes" in read ? sha256Hex(read.bytes.toString("utf8")) : undefined;
  } catch {
    return undefined;
  }
}

/* A measurement execution as a recount reads it; none when it measured nothing. */
export const dumpsOf = (measured: MeasurementOutcome | undefined): MeasuredDumps[] =>
  measured === undefined || "notRun" in measured ? [] : [{ namespace: measured.namespace, files: measured.files, exceptTests: measured.failedOnlyUnderMeasurement.map(testOfCase) }];

/* A case whose bytes ran green in the verdict: a real pass, or a flaky case (it passed on a retry), whose bytes a flaky run still has green. */
const ranGreen = (c: QaCase): boolean => isRealPass(c.status === "flaky" ? { ...c, status: "pass" } : c);

/* The run's change holds no changed code line, as the objective signal tells it before anything runs; a port that cannot tell says nothing (ADR-0005: such a change is unknown, measured or not). */
export const changesNoCode = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean => {
  const diff = state.classification.diff;
  return !!diff && ctx.deps.objectiveSignal.holdsChangedCode?.(diff) === false;
};

/* The measurement execution runs where a measurement can read it: a green run whose coverage policy is not off, on one repo, with a diff that may hold a code line to count. */
export const measuresByExecution = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean =>
  measuresCoverage(state, ctx) && ctx.cfg.coveragePolicyMode !== "off" && !ctx.input.triggerRepo && !!state.classification.diff && !changesNoCode(state, ctx);

/* The measurement execution of the verdict's passing tests, in the coverage purpose; the coverage phase opens here whether or not one is due. */
export async function executeMeasurement(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  if (!measuresByExecution(state, ctx)) return;
  const measuredBy = await runMeasurement(ctx, runOf(state).cases, `${ctx.input.runId}-measure`, "coverage");
  return { update: { coverage: { ...state.coverage, measuredBy, dumps: dumpsOf(measuredBy) } } };
}

/* What a measurement asks of the measurement execution it reads: its namespace, its passing tests as the baseline and their spec files, the tests whose dumps credit nothing, and its pages as the mutants' first observation. Nothing when no measurement execution ran. */
export function measuredByOptions(measured: MeasurementOutcome | undefined): { baselineCases?: string[]; opts: { namespace?: string; caseFiles?: string[]; exceptTests?: string[]; firstObservation?: MeasuredPages } } {
  if (measured === undefined || "notRun" in measured) return { opts: {} };
  const passed = new Set(measured.passed);
  const caseFiles = passingCaseFiles(measured.cases.filter((c) => passed.has(c.name)));
  return {
    baselineCases: measured.baseline,
    opts: {
      namespace: measured.namespace,
      ...(caseFiles.length > 0 ? { caseFiles } : {}),
      ...(measured.failedOnlyUnderMeasurement.length > 0 ? { exceptTests: measured.failedOnlyUnderMeasurement.map(testOfCase) } : {}),
      firstObservation: { cases: measured.cases, ...(measured.observations ? { observations: measured.observations } : {}) },
    },
  };
}

/* Whether a measurement execution was due and measured nothing. */
export const measurementNotRun = (state: Readonly<RunState>): boolean => state.coverage.measuredBy !== undefined && "notRun" in state.coverage.measuredBy;

/* The record of the measurement execution beside the coverage it gave. */
const measuredByRecord = (measured: MeasurementOutcome | undefined) =>
  measured === undefined || "notRun" in measured ? undefined : { namespace: measured.namespace, tests: measured.tests, failedOnlyUnderMeasurement: [...measured.failedOnlyUnderMeasurement] };

/* The coverage of a measurement execution that measured nothing: unknown and why. Whether that blocks is the objective signal's to say (ADR-0005: unknown never blocks, under enforce too). The verdict is untouched. */
export function coverageNotMeasured(coverage: CoverageOutcome, blocks: (status: "unknown") => boolean, perCommit: boolean): CoverageOutcome {
  return {
    ...coverage,
    coverageRatio: null,
    coverageStatus: "unknown",
    coverageMeasured: perCommit,
    uncovered: [],
    perCandidate: undefined,
    branchCoverage: undefined,
    untakenArms: [],
    untakenArmsCurrent: false,
    bundleMutation: undefined,
    mutantProofs: [],
    survivorRuns: [],
    changeCoverage: { executableLines: 0, unmeasured: "measurement-not-run" },
    ranBy: undefined,
    mutationPass: undefined,
    blocksPublish: blocks("unknown"),
  };
}

/* The change-coverage of the green execution by execution alone, read once from the dumps of the measurement execution: what its passing tests ran, and the mutation pass due on it, if any. */
async function measureGreenRun(state: Readonly<RunState>, ctx: WorkspaceRunContext, exclusions: CoverageExclusions | undefined) {
  const { deps, input, workspace } = ctx;
  const { diff, intent } = state.classification;
  /* The same BlastRadius the ground phase queried the structural signal with. */
  const runBlastRadius = BlastRadius.of(input.sha, intent?.changedFiles ?? []);
  /*
   * The measurement execution's own passing tests are the green baseline the mutation pass judges against, and their spec files those a
   * mutant re-runs. A run no measurement execution was due for (the policy off, cross-repo, no diff) has nothing the measurement could
   * count; its verdict's passing tests stand for the baseline, as they did when the verdict's own execution was measured.
   */
  const fromExecution = measuredByOptions(state.coverage.measuredBy);
  const verdictCases = runOf(state).cases;
  const verdictFiles = passingCaseFiles(verdictCases);
  const measured = state.coverage.measuredBy !== undefined ? fromExecution : { baselineCases: verdictCases.filter(isRealPass).map((c) => c.name), opts: verdictFiles.length > 0 ? { caseFiles: verdictFiles } : {} };
  /* Cross-repo: the diff is starved so coverage is "unknown" (never blocks). */
  return deps.objectiveSignal.measure(runBlastRadius, workspace.specDir, input.triggerRepo ? undefined : diff, measured.baselineCases, {
    ...measured.opts,
    ...(state.grounding.candidates.length > 0 ? { candidates: state.grounding.candidates } : {}),
    ...(input.triggerRepo ? { crossRepo: true } : {}),
    ...(exclusions ? { exclusions } : {}),
    byExecution: true,
  });
}

/* The coverage a measurement of the green execution records; `mutationPass` is the mutation pass still to run on it. */
function coverageMeasured(state: Readonly<RunState>, ctx: WorkspaceRunContext, signal: CoverageSignal, exclusions: CoverageExclusions | undefined): CoverageOutcome {
  return {
    ...state.coverage,
    coverageRatio: signal.ratio,
    coverageStatus: signal.status,
    coverageMeasured: measuresPerCommit(ctx),
    uncovered: signal.uncovered ?? [],
    perCandidate: signal.measurement?.perCandidate,
    branchCoverage: branchCoverageOf(signal.measurement),
    untakenArms: signal.untakenArms ?? [],
    untakenArmsCurrent: true,
    bundleMutation: signal.bundleMutation,
    mutantProofs: signal.mutantProofs ?? [],
    survivorRuns: signal.survivorRuns ?? [],
    changeCoverage: withMeasuredBy(changeCoverageOf(signal.measurement), state.coverage.measuredBy),
    ranBy: signal.ranBy,
    exclusions,
    mutationPass: signal.mutationPass,
    /* Ask the port: only enforce+fail blocks. Unknown/pass never block. Do not re-implement the mode check here. */
    blocksPublish: ctx.deps.objectiveSignal.blocks(signal.status),
  };
}

/* The coverage by execution alone, recorded at once: the mutation pass that may follow is a step of its own, so a deadline that cuts it leaves this measurement standing. */
export async function measureCoverage(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  if (ctx.input.triggerRepo) {
    /* Log so a cross-repo "unknown" is diagnosable, never a silent null. */
    engineLog.info(`[qa] change-coverage: skipped — the changed lines live in ${ctx.input.triggerRepo}; browser coverage maps only the frontend (status=unknown).`);
  }
  if (measurementNotRun(state)) return { update: { coverage: coverageNotMeasured(state.coverage, (status) => ctx.deps.objectiveSignal.blocks(status), measuresPerCommit(ctx)) } };
  const exclusions = await coverageExclusionsOf(state, ctx);
  const signal = await measureGreenRun(state, ctx, exclusions);
  return { update: { coverage: coverageMeasured(state, ctx, signal, exclusions) } };
}

/* A measurement's record with the measurement execution it was read from; a measurement that records nothing (no changed code line) gets no record of its own, and the execution stays on the run's executions. */
export function withMeasuredBy(change: CoverageOutcome["changeCoverage"], measured: MeasurementOutcome | undefined): CoverageOutcome["changeCoverage"] {
  const record = measuredByRecord(measured);
  if (!record || !change) return change;
  return { ...change, measuredBy: record };
}

/*
 * What every re-run of a mutant or an unmutated observation is held to: the time `purpose` may still spend, read without allotting it,
 * the cases of the execution whose bytes it re-runs, whose measured durations estimate it, and the run's deadline, after which none
 * starts and one it cut is not judged.
 */
export function rerunBudgetOf(ctx: WorkspaceRunContext, purpose: DeadlinePurpose, cases: RerunBudget["cases"]): RerunBudget {
  const deadline = ctx.services.runDeadlinePort;
  return { allowance: () => deadline.peekAllowance?.(purpose) ?? null, cases, fired: () => deadline.fired?.() === true };
}

/* The mutation pass runs only on a measurement that found one due (mutants were chosen and there are passing cases to judge them against), on a port that can run it. */
export const measuresMutation = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean => state.coverage.mutationPass !== undefined && ctx.deps.objectiveSignal.measureMutation !== undefined;

/* Why the mutation pass is passed over: there was nothing to measure, or the measurement found no pass due (no mutant on the changed lines a test reached, no passing case to judge one against, or no mutation pass configured). */
export const mutationSkipReason = (state: Readonly<RunState>, ctx: WorkspaceRunContext): string => (measuresCoverage(state, ctx) ? "no-mutation-due" : coverageSkipReason(state, ctx));

/*
 * The mutation pass the measurement by execution found due, and the coverage it verifies: the mutants are those that measurement chose
 * and the dumps it read are not read again. It replaces the measurement by execution only when it completes and a mutant was judged,
 * unreadable or left out; a pass that came to none of those leaves it as it was. Its re-runs are held to the coverage purpose's
 * allowance, each estimated from the cases of the execution it judges.
 */
export async function measureMutation(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  /* Each re-run is estimated from the measurement execution, which ran instrumented as the mutants run. */
  const measured = state.coverage.measuredBy;
  const estimateFrom = measured !== undefined && !("notRun" in measured) ? measured.cases : runOf(state).cases;
  const signal = await ctx.deps.objectiveSignal.measureMutation!(state.coverage.mutationPass!, ctx.workspace.specDir, { rerunBudget: rerunBudgetOf(ctx, "coverage", estimateFrom), rerun: rerunsOfRun(ctx) });
  if (!signal.bundleMutation) return { update: { coverage: { ...state.coverage, mutationPass: undefined } } };
  return { update: { coverage: coverageMeasured(state, ctx, signal, state.coverage.exclusions) } };
}

/*
 * A re-run of the mutation pass (a mutant's, or an unmutated observation of the survivors) is an execution of the run's suite: it goes
 * through the run's execution port, which records it as it does every execution of the run. It runs
 * with coverage on and no retry, as the measurement execution a kill is judged against does; it adds the mutant's edit, and it is
 * observed only when the pass asks, while the measurement is always observed and held to a global timeout of its own.
 */
export const rerunsOfRun = (ctx: WorkspaceRunContext): MutantRerun => (args) =>
  ctx.deps.execution.execute(args.dir, {
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    namespace: args.namespace,
    specFiles: args.specFiles,
    retries: 0,
    coverage: true,
    ...(args.mutant !== undefined ? { mutant: args.mutant } : {}),
    ...(args.observe ? { observe: true } : {}),
  });

/* Whether the enforce-mode regeneration runs: a measurement that blocks publication, on a per-commit diff. */
export const regeneratesForCoverage = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean =>
  coverageRegenAction({ measured: measuresCoverage(state, ctx) && !measurementNotRun(state), blocks: state.coverage.blocksPublish, perCommit: measuresPerCommit(ctx), regenerated: state.loops.coverageRegen }) === "regenerate";

/* The mutants of the changed code that ran under a delivered test and that no test noticed. */
const survivorsOf = (state: Readonly<RunState>): readonly SurvivedMutant[] => state.coverage.bundleMutation?.survived ?? [];

/* Whether the branch-case regeneration runs: arms of the changed code no test ran, or mutants no test noticed, on a per-commit diff whose measurement blocks nothing (a blocking one regenerates for coverage, with the same gap), with the branch cases on. */
export const regeneratesForBranchCases = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean =>
  branchCasesAction({
    measured: measuresCoverage(state, ctx),
    blocks: state.coverage.blocksPublish,
    perCommit: measuresPerCommit(ctx),
    enabled: ctx.cfg.coverageBranchCases === "regenerate",
    /* Both are cases still missing: the arms no test ran and the mutants no test noticed. */
    untakenArms: state.coverage.untakenArms.length + survivorsOf(state).length,
  }) === "regenerate";

/*
 * How a gap regeneration ended; `namespace` is the acceptance's, which its measurement execution extends; `changedSpecFiles` are the
 * specs an accepted one changed and kept, every one executed on its accepted bytes, whose cases in `run` are that execution's; `files`
 * counts the spec files the turn changed whose new bytes stand and those given their prior bytes back.
 */
export interface GapRegeneration {
  outcome: BranchCasesOutcome["outcome"];
  run: NonNullable<RunState["execution"]["run"]>;
  acceptanceCalls: number;
  leadCorrections: number;
  namespace?: string;
  changedSpecFiles?: string[];
  files?: { kept: number; restored: number };
}

/* What one acceptance kept and gave back, as an event on the open phase's span. Observability never changes the run. */
export function traceAcceptedFiles(ctx: WorkspaceRunContext, origin: CorrectionOrigin, files: { kept: number; restored: number }): void {
  try {
    ctx.trail.spans.event("regeneration_acceptance", {
      "qayaba.regeneration.origin": origin,
      "qayaba.regeneration.kept_files": files.kept,
      "qayaba.regeneration.restored_files": files.restored,
    });
  } catch (err) {
    engineLog.error(`[qa] the regeneration's acceptance could not be traced (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/*
 * One regeneration at a gap of the change: its changed specs go through acceptance and execute green before they stand. A run_spec
 * proof is not reused here: the proof says the bytes passed, not which tests they hold nor what they ran, and the regeneration exists
 * to change exactly that (the survivor closure judges its cases, the recount reads its dumps), so only an execution of the accepted
 * bytes can stand for it. A turn that changed spec files only is accepted file by file: the spec files whose cases all passed stand and the others
 * get their prior bytes, cases and delivery back. A turn that delivers nothing, or whose specs are rejected or capped, keeps the first
 * measurement and restores the prior bytes. A throw propagates; a spent run deadline is the one the policy degrades (this step runs
 * after a green suite), so the first measurement stands.
 */
export async function regenerateAtGap(
  state: Readonly<RunState>,
  ctx: WorkspaceRunContext,
  enrichment: GenerationEnrichment,
  origin: Exclude<CorrectionOrigin, typeof CORRECTION_ORIGIN.REVIEW>,
  evidence?: readonly EvidenceFinding[],
): Promise<GapRegeneration> {
  const { workspace, services } = ctx;
  const snapshot = await services.snapshotSuite();
  /* mutation-scope:begin delivered-before-coverage-regen */
  const deliveredBefore = state.generation.delivered;
  /* mutation-scope:end delivered-before-coverage-regen */
  try {
    return await regenerateWithin(state, ctx, enrichment, origin, evidence, snapshot, deliveredBefore);
  } catch (err) {
    /*
     * The share of the run's time this purpose is allotted ended in the turn (or before the acceptance could execute): that is this
     * regeneration's end alone, not the run's. Whatever the turn wrote is put back, the first measurement stands, and the run goes on
     * to the phases whose time the allotment held back (the review among them).
     */
    if (!isAllotmentSpentError(err)) throw err;
    const changed = await services.suiteChangedFiles(snapshot, []);
    if (changed.length > 0) await services.snapshotPort.restore(workspace.specDir, snapshot, changed.filter((file) => !snapshot.files.has(file)));
    rollbackDelivered(state, deliveredBefore);
    recordLimit(state, { fired: "allotment", role: err.role, purpose: err.purpose });
    engineLog.warn(`[qa] the ${origin} regeneration ran out of the time allotted to ${err.purpose}; what it wrote is put back and the first measurement stands`);
    return { outcome: "empty", run: runOf(state), acceptanceCalls: state.coverage.acceptanceCalls, leadCorrections: 0 };
  }
}

async function regenerateWithin(
  state: Readonly<RunState>,
  ctx: WorkspaceRunContext,
  enrichment: GenerationEnrichment,
  origin: Exclude<CorrectionOrigin, typeof CORRECTION_ORIGIN.REVIEW>,
  evidence: readonly EvidenceFinding[] | undefined,
  snapshot: Awaited<ReturnType<WorkspaceRunContext["services"]["snapshotSuite"]>>,
  deliveredBefore: RunState["generation"]["delivered"],
): Promise<GapRegeneration> {
  const { input, workspace, services } = ctx;
  const { acceptance, integrityCounters, snapshotPort, runDeadlinePort, suiteChangedFiles, acceptanceScope } = services;
  let { acceptanceCalls } = state.coverage;
  let run = runOf(state);
  const regenerated = await regenerate(state, ctx, undefined, enrichment, origin, evidence);
  const regen = regenerated.output;
  const { leadCorrections } = regenerated;
  await services.confinement.enforce();
  const changedFiles = await suiteChangedFiles(snapshot, regen.specs);
  const changedSpecFiles = acceptanceScope(changedFiles);
  if (regen.specs.length === 0) {
    /* A turn that delivers no specs is not a change to accept: whatever it wrote is put back. */
    if (changedFiles.length > 0) {
      await snapshotPort.restore(workspace.specDir, snapshot, changedFiles.filter((file) => !snapshot.files.has(file)));
    }
    rollbackDelivered(state, deliveredBefore);
    return { outcome: "empty", run, acceptanceCalls, leadCorrections };
  }
  if (changedSpecFiles.length === 0) return { outcome: "empty", run, acceptanceCalls, leadCorrections };
  const namespace = acceptanceNamespace(input.runId, acceptanceCalls++);
  const outcome = await acceptance.accept({
    specDir: workspace.specDir,
    changedSpecFiles,
    namespace,
    snapshot,
    prior: run,
    independentSpecs: changedFiles.every(isSpecFile),
    deadline: runDeadlinePort,
    validate: validateAccepted(state, ctx),
    execute: executeAccepted(ctx),
  });
  if (outcome.kind !== "accepted") {
    /* Rejected or capped: the turn's specs are not the run's; the first measurement and the prior bytes stand. */
    rollbackDelivered(state, deliveredBefore);
    if (outcome.kind === "rejected") integrityCounters.rejected += 1;
    else integrityCounters.capHit = true;
    const files = { kept: 0, restored: changedSpecFiles.length };
    traceAcceptedFiles(ctx, origin, files);
    return { outcome: outcome.kind === "rejected" ? "rejected" : "capped", run, acceptanceCalls, leadCorrections, files };
  }
  integrityCounters.acceptances += 1;
  const kept = [...outcome.kept];
  /* A spec file given its prior bytes back keeps its prior cases and delivery: only the kept files' are the turn's. */
  if (outcome.restored.length > 0) rollbackDelivered(state, deliveredBefore, outcome.restored);
  const files = { kept: kept.length, restored: outcome.restored.length };
  traceAcceptedFiles(ctx, origin, files);
  /* The kept files executed in the acceptance: their cases replace the ones the run held for them. A spec file given back keeps its prior cases. */
  const keptSet = new Set(kept);
  run = {
    ...run,
    cases: [...run.cases.filter((c) => !keptSet.has(c.file ?? c.name)), ...(outcome.execution?.cases ?? [])],
    skippedTests: [...(run.skippedTests ?? []).filter((t) => !keptSet.has(t.file ?? t.name)), ...(outcome.execution?.skippedTests ?? [])],
  };
  return { outcome: "accepted", run, acceptanceCalls, leadCorrections, namespace, changedSpecFiles: kept, files };
}

const isSpecFile = (file: string): boolean => file.endsWith(".spec.ts");

/* A re-check that fails judged nothing: the closure is a signal, so its fault is logged and never ends the run. */
async function recheckOrNone(recheck: () => Promise<BundleMutationResult | null>): Promise<BundleMutationResult | null> {
  try {
    return await recheck();
  } catch (err) {
    engineLog.warn(`[qa] survivor closure: the re-check of the surviving mutants failed; none is judged (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

/*
 * The measurement execution of the files an accepted gap regeneration kept: their passing tests in the acceptance, run once more
 * measured, under `<acceptance namespace>-measure` (RFC-0015). The acceptance judged them and measured nothing. Undefined when there
 * is nothing to measure: the regeneration was not accepted, kept no file, or the run took no measurement its dumps would add to.
 */
export async function measureKept(state: Readonly<RunState>, ctx: WorkspaceRunContext, regen: GapRegeneration): Promise<MeasurementOutcome | undefined> {
  const kept = new Set(regen.changedSpecFiles ?? []);
  if (regen.outcome !== "accepted" || kept.size === 0 || regen.namespace === undefined || state.coverage.dumps.length === 0) return undefined;
  return runMeasurement(ctx, regen.run.cases.filter((c) => c.file !== undefined && kept.has(c.file)), `${regen.namespace}-measure`, "coverage");
}

/*
 * Whether an accepted regeneration answered the surviving mutants routed to it: each is applied again to the specs it changed among
 * those its finding was routed to, judged against the tests of those specs that passed in their measurement execution. Both sides of a
 * kill run instrumented alike (coverage on, no retry, through the run's execution port); they differ in the mutant's edit, and the
 * measurement side is also observed and held to a global timeout of its own (`rerunsOfRun`). The proof of a regenerated test is that the
 * fault it was asked about now fails it; until then it is only text. Undefined when no survivor was routed or the regeneration was not
 * accepted. A signal, never a gate.
 */
export async function closeSurvivors(state: Readonly<RunState>, ctx: WorkspaceRunContext, regen: GapRegeneration, measured: MeasurementOutcome | undefined): Promise<SurvivorClosure | undefined> {
  const { deps, input, workspace } = ctx;
  const routed = state.coverage.survivorRuns;
  const changed = regen.changedSpecFiles ?? [];
  if (regen.outcome !== "accepted" || routed.length === 0 || changed.length === 0 || !deps.objectiveSignal.recheckSurvivors) return undefined;
  const changedSet = new Set(changed);
  const measuredCases = measured !== undefined && !("notRun" in measured) ? measured.cases : [];
  const baseline = new Set(measured !== undefined && !("notRun" in measured) ? measured.baseline : []);
  const baselineCases = measuredCases.filter((c) => baseline.has(c.name) && changedSet.has(c.file ?? c.name)).map((c) => c.name);
  const rechecks = survivorRechecks(routed, survivorsOf(state), changed);
  /* The re-runs are the coverage purpose's, estimated from the measurement execution of the regenerated bytes they re-run. */
  const rerunBudget = rerunBudgetOf(ctx, "coverage", measuredCases);
  const result = baselineCases.length > 0 && rechecks.length > 0 ? await recheckOrNone(() => deps.objectiveSignal.recheckSurvivors!(rechecks, workspace.specDir, `${input.runId}-closure`, baselineCases, { rerunBudget, rerun: rerunsOfRun(ctx) })) : null;
  /* A measurement the time left could not hold leaves every re-check unstarted for the same reason. */
  const outOfTime = measured !== undefined && "notRun" in measured && measured.time === true && rechecks.length > 0;
  const closure = outOfTime ? { ...survivorClosureOf(routed.length, null), leftOut: { mutants: rechecks.length, observations: 0, reason: "time" as const } } : survivorClosureOf(routed.length, result);
  engineLog.info(`[qa] survivor closure: ${closure.closed} of ${closure.routed} surviving mutant(s) now noticed by a test (${closure.judged} judged)`);
  if (closure.leftOut) engineLog.warn(`[qa] survivor closure: ${closure.leftOut.mutants} surviving mutant(s) were not re-applied because the time left could not hold their re-run`);
  if (closure.unreadable) engineLog.warn(`[qa] survivor closure: ${closure.unreadable} surviving mutant(s) were not judged because the counters of their re-run could not be read (not the same as a mutant that reached no page)`);
  return closure;
}

/*
 * Where a recount reads each spec file: the last measurement execution that ran the bytes now on disk, by their fingerprint. Null
 * when a spec file some measurement ran holds bytes none of them ran: counting it from another's dumps would describe bytes that are
 * not under review. `chosen` maps each file to the namespace it is read from.
 */
function sourcesFor(ctx: WorkspaceRunContext, dumps: readonly MeasuredDumps[]): { sources: CoverageSource[]; chosen: Map<string, string> } | null {
  const chosen = new Map<string, string>();
  for (const file of new Set(dumps.flatMap((d) => d.files.map((f) => f.file)))) {
    const now = bytesOf(ctx, file);
    const ran = [...dumps].reverse().find((d) => d.files.some((f) => f.file === file && f.sha === now));
    if (!ran) {
      engineLog.warn(`[qa] change-coverage: ${file} holds bytes no measurement execution ran; the coverage is not recounted and the measurement before stands`);
      return null;
    }
    chosen.set(file, ran.namespace);
  }
  const sources = dumps.flatMap((d): CoverageSource[] => {
    const specFiles = [...chosen].filter(([, namespace]) => namespace === d.namespace).map(([file]) => file);
    return specFiles.length === 0 ? [] : [{ namespace: d.namespace, specFiles, ...(d.exceptTests.length > 0 ? { exceptTests: d.exceptTests } : {}) }];
  });
  return { sources, chosen };
}

/*
 * The coverage after a gap regeneration, counted again from the dumps of the measurement executions when it was accepted: the files
 * it kept from `measured`, their own measurement execution, every other from the one that ran its bytes on disk. The arms and lines
 * the reviewer and the record describe are then the delivered bytes'. Under enforce only the final whole-suite re-measure decides, so
 * the recount informs and never touches the decision; under signal it is the measurement, and only the value score stays stale. A
 * measurement of the kept files that did not run, or bytes no measurement ran, make no recount: the arms are then not current.
 */
export async function recountAfter(state: Readonly<RunState>, ctx: WorkspaceRunContext, regen: GapRegeneration, measured: MeasurementOutcome | undefined): Promise<CoverageOutcome> {
  const { deps, input, cfg, workspace } = ctx;
  const spent = withAcceptanceCalls(state.coverage, regen.acceptanceCalls);
  if (regen.outcome !== "accepted") return spent;
  const dumps = [...state.coverage.dumps, ...dumpsOf(measured)];
  const accepted = { ...acceptedRegeneration(spent), dumps };
  const read = measured !== undefined && !("notRun" in measured) && deps.objectiveSignal.recount ? sourcesFor(ctx, dumps) : null;
  /* A proof holds only for the spec bytes that killed its mutant: those the first measurement execution ran. */
  const proven = state.coverage.dumps[0]?.namespace;
  const proofs = read ? state.coverage.mutantProofs.map((p) => ({ ...p, specFiles: p.specFiles.filter((file) => read.chosen.get(file) === proven) })).filter((p) => p.specFiles.length > 0) : [];
  const recount = read
    ? await deps.objectiveSignal.recount!(BlastRadius.of(input.sha, state.classification.intent?.changedFiles ?? []), workspace.specDir, state.classification.diff, read.sources, {
        ...(proofs.length > 0 ? { proofs } : {}),
        ...(state.coverage.exclusions ? { exclusions: state.coverage.exclusions } : {}),
        caseFiles: passingCaseFiles(regen.run.cases),
      })
    : null;
  if (!recount) return { ...accepted, untakenArmsCurrent: false };
  const arms: CoverageOutcome = { ...accepted, uncovered: recount.uncovered, untakenArms: recount.untakenArms, untakenArmsCurrent: true, ranBy: recount.ranBy, branchCoverage: branchCoverageOf(recount.measurement), changeCoverage: recount.measurement.unmeasured === undefined ? (changeCoverageOf(recount.measurement) ?? accepted.changeCoverage) : accepted.changeCoverage };
  if (cfg.coveragePolicyMode !== "signal") return arms;
  return {
    ...remeasured(arms),
    coverageRatio: recount.ratio,
    coverageStatus: recount.status,
  };
}

/* The spec files of the passing cases of an execution. */
function passingCaseFiles(cases: readonly QaCase[]): string[] {
  return [...new Set(cases.flatMap((c) => (isRealPass(c) && c.file ? [c.file] : [])))];
}

/* One unit of the gap: what the lead is shown, and the structured finding the orchestrator routes by the file it names. */
export interface GapUnit {
  text: string;
  finding: CorrectionFinding;
}

/* The items of the groups taken one group at a time, round-robin, so the first of each group come first and no group crowds the others out. Every item is kept. */
function interleave<T>(groups: ReadonlyMap<string, readonly T[]>): T[] {
  const lists = [...groups.values()];
  const picked: T[] = [];
  for (let round = 0; lists.some((list) => round < list.length); round++) {
    for (const list of lists) if (round < list.length) picked.push(list[round]!);
  }
  return picked;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

/*
 * The gap as separate units, one per file with uncovered changed lines and one per decision arm no test ran: the lead routes findings
 * by number, so each number must name one unit it can hand to a flow, and each unit names its file so the orchestrator can route it by
 * the use case that file seeds, and the spec files whose tests ran that file (`ranBy`, from the dumps the measurement read), which settle
 * the flow of a file several flows hold. Every unit is kept: files are listed across use cases and arms across files, so what comes first
 * is the breadth of the gap, and the lead's turn gives them up as references to their files only when its window cannot hold them. An arm
 * on a page a passing case checked only as DEV served it empty (`onEmptyPages`, from `armsOnPinnedPages`) says so: the data that takes
 * it may be what DEV lacks there.
 */
export function gapUnits(uncovered: CoverageOutcome["uncovered"], arms: CoverageOutcome["untakenArms"], candidates: RunState["grounding"]["candidates"], ranBy: CoverageOutcome["ranBy"] = [], onEmptyPages: ReadonlyArray<{ file: string; line: number; pages: readonly string[] }> = []): GapUnit[] {
  const ran = (file: string): Pick<CorrectionFinding, "ranBy"> => {
    const specs = ranBy.find((r) => r.file === file)?.specFiles;
    return specs && specs.length > 0 ? { ranBy: specs } : {};
  };
  const owner = (file: string): string => candidatesSeededBy(file, candidates ?? [])[0]?.id ?? "";
  return [
    ...interleave(groupBy(uncovered, (u) => owner(u.file))).map((u) => {
      const text = renderCoverageGap([u], candidates);
      return { text, finding: { text, file: u.file, ...ran(u.file) } };
    }),
    ...interleave(groupBy(arms, (u) => u.file)).map((u) => {
      const pages = onEmptyPages.find((a) => a.file === u.file && a.line === u.line)?.pages ?? [];
      const empty = pages.length > 0 ? ` (on ${pages.join(", ")}, which DEV served as a confirmed empty state: the data that takes this arm may be what DEV lacks there)` : "";
      const text = `decision arm on a changed line that NO test ran: ${u.file}:${u.line} ${u.kind}: ${u.arm}${empty}`;
      return { text, finding: { text, file: u.file, line: u.line, ...ran(u.file) } };
    }),
  ];
}

/*
 * The findings of a gap: one per unit, carrying the file it names so the orchestrator routes it by the use case that file seeds, then
 * one per surviving mutant and spec it is routed to (the specs that reached it whose own pages moved, else every spec that reached it),
 * carrying that spec so the lead's pass hands it to the flow that owns the spec; a mutant no spec is recorded as reaching has no owner
 * and is told to the lead as it is. A gap with neither units nor survivors is read whole as one finding; an empty one gives none.
 */
export function gapFindings(gap: string, units: readonly GapUnit[], survived: readonly SurvivedMutant[]): EvidenceFinding[] | undefined {
  const findings: EvidenceFinding[] = [
    ...(units.length > 0 ? units.map((u) => ({ finding: u.finding })) : survived.length > 0 && gap ? [{ finding: { text: gap } }] : []),
    ...survived.flatMap((m) => survivorFindings(m).map(({ spec, text }) => ({ finding: { text, ...(spec ? { spec } : {}) } }))),
  ];
  return findings.length > 0 ? findings : undefined;
}

/*
 * The gap as references, for an author whose prompt is over its window: the files the gap is about and how many of its units each
 * holds, and the files whose changed code survived a mutant. The units themselves are what the window could not hold.
 */
export function gapReference(units: readonly GapUnit[], survived: readonly SurvivedMutant[]): string {
  const byFile = new Map<string, number>();
  for (const unit of units) byFile.set(unit.finding.file ?? "", (byFile.get(unit.finding.file ?? "") ?? 0) + 1);
  const files = [...byFile].map(([file, count]) => `- ${file}: ${count} unit(s) (changed lines or decision arms no test ran)`);
  const mutated = [...new Set(survived.map((m) => m.file))].map((file) => `- ${file}: a mutant of its changed code that no test noticed`);
  return [...files, ...mutated].join("\n");
}

/*
 * A regeneration at the coverage gap: its units routed by the file each names, the surviving mutants by the spec that reached them, and
 * each case that checked a page only as DEV served it empty by its spec (`pinned`); an author that has no lead reads the gap whole,
 * survivors and pinned cases included. The pinned cases join a regeneration the gap starts; they start none of their own.
 */
function regenerateAtCoverageGap(state: Readonly<RunState>, ctx: WorkspaceRunContext, base: string, units: readonly GapUnit[], survived: readonly SurvivedMutant[], pinned: ReadonlyArray<{ finding: CorrectionFinding }> = []): Promise<GapRegeneration> {
  const gap = [base, renderSurvivedMutants(survived), ...pinned.map((p) => p.finding.text)].filter(Boolean).join("\n\n");
  const findings = [...(gapFindings(base, units, survived) ?? []), ...pinned];
  return regenerateAtGap(state, ctx, { coverageGap: gap, coverageGapReference: gapReference(units, survived), coverageGapItems: units.map((u) => u.text) }, CORRECTION_ORIGIN.COVERAGE, findings.length > 0 ? findings : undefined);
}

/* The run's pinned cases as the gap carries them: the untaken arms on their pages, and one finding per case for the flow that owns its spec, naming the places the app declares. */
function ambientGapOf(state: Readonly<RunState>, ctx: WorkspaceRunContext): { arms: AmbientRecord["arms"]; findings: Array<{ finding: CorrectionFinding }> } {
  const record = ambientRecordOf(state, ctx);
  if (!record) return { arms: [], findings: [] };
  return { arms: record.arms, findings: ambientPinFindings(record.pins, ctx.trail.geolocation?.placeNames() ?? []) };
}

/* Enforce-mode one-shot coverage regeneration at the uncovered lines and the arms no test ran; it runs at most once per run and is independent of the FixLoop budget. The whole-suite re-measure that decides coverage is the single final re-measure before decide. */
export async function regenerateForCoverage(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { uncovered, untakenArms } = state.coverage;
  const survived = survivorsOf(state);
  const gap = [renderCoverageGap(uncovered, state.grounding.candidates), renderBranchGap(untakenArms)].filter(Boolean).join("\n\n");
  const ambient = ambientGapOf(state, ctx);
  const regen = await regenerateAtCoverageGap(state, ctx, gap, gapUnits(uncovered, untakenArms, state.grounding.candidates, state.coverage.ranBy, ambient.arms), survived, ambient.findings);
  const measured = await measureKept(state, ctx, regen);
  const survivorClosure = await closeSurvivors(state, ctx, regen, measured);
  const coverage = await recountAfter(state, ctx, regen, measured);
  return { update: { execution: withRun(state.execution, regen.run), coverage: { ...coverage, ...(survivorClosure ? { survivorClosure } : {}) }, loops: { ...state.loops, coverageRegen: state.loops.coverageRegen + 1, leadCorrections: state.loops.leadCorrections + regen.leadCorrections } } };
}

/* The one regeneration from the arms of the changed code no test ran and the mutants no test noticed: they are the cases still missing. It never blocks; what it did is recorded with the arms before and after it. */
export async function regenerateForBranchCases(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const armsBefore = state.coverage.untakenArms.length;
  const survived = survivorsOf(state);
  const ambient = ambientGapOf(state, ctx);
  const regen = await regenerateAtCoverageGap(state, ctx, renderBranchGap(state.coverage.untakenArms), gapUnits([], state.coverage.untakenArms, [], state.coverage.ranBy, ambient.arms), survived, ambient.findings);
  const measured = await measureKept(state, ctx, regen);
  const survivorClosure = await closeSurvivors(state, ctx, regen, measured);
  const coverage = await recountAfter(state, ctx, regen, measured);
  const armsAfter = regen.outcome !== "accepted" ? armsBefore : coverage.untakenArmsCurrent ? coverage.untakenArms.length : undefined;
  return {
    update: {
      execution: withRun(state.execution, regen.run),
      coverage: { ...coverage, ...(survivorClosure ? { survivorClosure } : {}), branchCases: { outcome: regen.outcome, armsBefore, ...(armsAfter !== undefined ? { armsAfter } : {}), ...regen.files } },
      loops: { ...state.loops, leadCorrections: state.loops.leadCorrections + regen.leadCorrections },
    },
  };
}
