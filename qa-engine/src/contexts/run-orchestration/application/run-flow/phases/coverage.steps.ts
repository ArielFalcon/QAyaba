/* The coverage phase of a run: the change-coverage measurement of a green execution and at most one regeneration at its gap: in enforce mode at the uncovered lines (with the arms no test ran), otherwise, with the branch cases on, at the arms no test ran. The mutants of the changed code that ran under a test and that no test noticed are part of that gap: the test reached the change and checked nothing. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { CORRECTION_ORIGIN, type CorrectionFinding, type CorrectionOrigin } from "@contexts/coordination/application/index.ts";
import { faultAimOf } from "../fault-aim.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { candidatesSeededBy } from "@kernel/change-map.ts";
import { hasGreenBytes } from "@kernel/run-verdict.ts";
import type { GenerationEnrichment } from "@contexts/generation/application/index.ts";
import { changedCodeFiles, renderBranchGap, renderCoverageGap, renderSurvivedMutant, renderSurvivedMutants, survivorClosureOf, survivorRechecks, testSupportFiles, unreachableByDesign, type BundleMutationResult, type CoverageExclusions, type CoverageMeasurement, type CoverageRerun, type SurvivedMutant, type SurvivorClosure } from "@contexts/objective-signal/application/index.ts";
import type { StepOutcome } from "../run-flow.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import { runOf, type BranchCasesOutcome, type CoverageOutcome, type RunState } from "../run-state.ts";
import { acceptedRegeneration, remeasured, rollbackDelivered, withAcceptanceCalls, withRun } from "../reducers.ts";
import { executeAccepted, validateAccepted } from "./execute.steps.ts";
import { regenerate, type EvidenceFinding } from "./generation-services.ts";
import { branchCasesAction, coverageRegenAction } from "../../../domain/coverage-regen.ts";

type Result = Promise<StepOutcome<RunState>>;

/* A context run executes nothing (its pass is synthetic), so it has no coverage or value to measure. */
export const measuresCoverage = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean => hasGreenBytes(runOf(state).verdict) && ctx.input.mode !== "context";

/* The arms of the decisions on changed lines a measurement counted, and how many ran; undefined when it saw none. */
export const branchCoverageOf = (m: CoverageMeasurement | undefined): CoverageOutcome["branchCoverage"] =>
  m?.changedBranches !== undefined ? { changed: m.changedBranches, taken: m.takenBranches ?? 0 } : undefined;

/* The part of a measurement the run records beside its ratio; undefined when it measured nothing. */
export function changeCoverageOf(m: CoverageMeasurement | undefined): CoverageOutcome["changeCoverage"] {
  if (!m || m.unmeasured !== undefined) return undefined;
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

export async function measureCoverage(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, workspace } = ctx;
  const run = runOf(state);
  const { diff, intent } = state.classification;
  /* The same BlastRadius the ground phase queried the structural signal with; measure() scopes the code-target oracle to it. */
  const runBlastRadius = BlastRadius.of(input.sha, intent?.changedFiles ?? []);
  /*
   * Change-coverage assembler runs only when a real per-commit diff is present.
   * Cross-repo: starve the diff arg so coverage is "unknown" (never blocks) while
   * the value-oracle inside measure() still runs.
   */
  if (input.triggerRepo) {
    /* Log so a cross-repo "unknown" is diagnosable, never a silent null. */
    engineLog.info(`[qa] change-coverage: skipped — the changed lines live in ${input.triggerRepo}; browser coverage maps only the frontend (status=unknown).`);
  }
  /* This pass's own passing case names — the green baseline the fault-injection oracle needs. */
  const passed = run.cases.filter((c) => c.status === "pass");
  const baselineCases = passed.map((c) => c.name);
  /* The spec files of those cases: a mutant re-runs the ones whose tests reached it, and a dump tells which changed file a spec ran only among them. */
  const caseFiles = passingCaseFiles(run.cases);
  /* The loop's last whole-suite execution and the re-runs of some spec files after it: the measurement reads the latest dumps of every spec file. */
  const { coverageNamespace, coverageReruns } = state.fixLoop;
  /* The response oracle corrupts only the operations the change reaches; with no scope it has nothing to corrupt. */
  const faultAim = faultAimOf({ scope: state.grounding.changeScope, candidates: state.grounding.candidates, flowCandidates: state.generation.flowCandidates });
  const exclusions = await coverageExclusionsOf(state, ctx);
  const signal = await deps.objectiveSignal.measure(
    runBlastRadius,
    workspace.specDir,
    input.triggerRepo ? undefined : diff,
    baselineCases,
    ...(coverageNamespace || coverageReruns.length > 0 || caseFiles.length > 0 || state.grounding.candidates.length > 0 || faultAim !== undefined || exclusions !== undefined
      ? [{
          ...(coverageNamespace ? { namespace: coverageNamespace } : {}),
          ...(coverageReruns.length > 0 ? { reruns: coverageReruns } : {}),
          ...(caseFiles.length > 0 ? { caseFiles } : {}),
          ...(state.grounding.candidates.length > 0 ? { candidates: state.grounding.candidates } : {}),
          ...(input.triggerRepo ? { crossRepo: true } : {}),
          ...(faultAim ? { faultAim } : {}),
          ...(exclusions ? { exclusions } : {}),
        }]
      : []),
  );
  return {
    update: {
      coverage: {
        ...state.coverage,
        coverageRatio: signal.ratio,
        coverageStatus: signal.status,
        coverageMeasured: measuresPerCommit(ctx),
        valueScore: signal.valueScore ?? null,
        valueByCandidate: signal.valueByCandidate,
        valueStats: signal.valueStats,
        mutantCount: signal.mutantCount ?? undefined,
        killedCount: signal.killedCount ?? undefined,
        uncovered: signal.uncovered ?? [],
        perCandidate: signal.measurement?.perCandidate,
        branchCoverage: branchCoverageOf(signal.measurement),
        untakenArms: signal.untakenArms ?? [],
        untakenArmsCurrent: true,
        bundleMutation: signal.bundleMutation,
        mutantProofs: signal.mutantProofs ?? [],
        survivorRuns: signal.survivorRuns ?? [],
        changeCoverage: changeCoverageOf(signal.measurement),
        ranBy: signal.ranBy,
        exclusions,
        /*
         * Ask the port: only enforce+fail blocks. Unknown/pass never block. Do not
         * re-implement the mode check here.
         */
        blocksPublish: deps.objectiveSignal.blocks(signal.status),
      },
    },
  };
}

/* Whether the enforce-mode regeneration runs: a measurement that blocks publication, on a per-commit diff. */
export const regeneratesForCoverage = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean =>
  coverageRegenAction({ measured: measuresCoverage(state, ctx), blocks: state.coverage.blocksPublish, perCommit: measuresPerCommit(ctx), regenerated: state.loops.coverageRegen }) === "regenerate";

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
 * How a gap regeneration ended; `reruns` names the acceptance's own dumps of the specs it kept when every one of them executed in it,
 * so the coverage can be recounted from them; `changedSpecFiles` are the specs an accepted one changed and kept;
 * `files` counts the spec files the turn changed whose new bytes stand and those given their prior bytes back.
 */
export interface GapRegeneration {
  outcome: BranchCasesOutcome["outcome"];
  run: NonNullable<RunState["execution"]["run"]>;
  acceptanceCalls: number;
  leadCorrections: number;
  reruns?: CoverageRerun[];
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
 * One regeneration at a gap of the change: its changed specs go through acceptance, so they execute green (or reuse a proof) before
 * they stand. A turn that changed spec files only is accepted file by file: the spec files whose cases all passed stand and the others
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
  const { input, trail, workspace, services } = ctx;
  const { acceptance, integrityCounters, snapshotPort, runDeadlinePort, suiteChangedFiles, snapshotSuite, acceptanceScope } = services;
  let { acceptanceCalls } = state.coverage;
  let run = runOf(state);
  const snapshot = await snapshotSuite();
  /* mutation-scope:begin delivered-before-coverage-regen */
  const deliveredBefore = state.generation.delivered;
  /* mutation-scope:end delivered-before-coverage-regen */
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
  const { closedLoop } = trail;
  const namespace = `${input.runId}-acc${acceptanceCalls++}`;
  const outcome = await acceptance.accept({
    specDir: workspace.specDir,
    changedSpecFiles,
    namespace,
    snapshot,
    independentSpecs: changedFiles.every(isSpecFile),
    ...(closedLoop ? { closedLoop } : {}),
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
  if (outcome.executedSpecs.length === 0) integrityCounters.proofReused += 1;
  const kept = [...outcome.kept];
  /* A spec file given its prior bytes back keeps its prior cases and delivery: only the kept files' are the turn's. */
  if (outcome.restored.length > 0) rollbackDelivered(state, deliveredBefore, outcome.restored);
  if (outcome.execution?.cases.length) {
    const keptSet = new Set(kept);
    run = { ...run, cases: [...run.cases.filter((c) => !keptSet.has(c.file ?? c.name)), ...outcome.execution.cases] };
  }
  const files = { kept: kept.length, restored: outcome.restored.length };
  traceAcceptedFiles(ctx, origin, files);
  /*
   * A spec whose proof was reused left no dumps here: the coverage cannot be recounted without it. A spec file given back is not named,
   * so its dumps here are never read: it is counted from the dumps of the bytes it was given back.
   */
  const executed = new Set(outcome.executedSpecs);
  const recountable = kept.every((file) => executed.has(file));
  return { outcome: "accepted", run, acceptanceCalls, leadCorrections, changedSpecFiles: kept, files, ...(recountable ? { reruns: [{ namespace, specFiles: kept }] } : {}) };
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
 * Whether an accepted regeneration answered the surviving mutants routed to it: each is applied again to the specs it changed, judged
 * against those specs' passing cases. The proof of a regenerated test is that the fault it was asked about now fails it; until then it
 * is only text. Undefined when no survivor was routed or the regeneration was not accepted. A signal, never a gate.
 */
export async function closeSurvivors(state: Readonly<RunState>, ctx: WorkspaceRunContext, regen: GapRegeneration): Promise<SurvivorClosure | undefined> {
  const { deps, input, workspace } = ctx;
  const routed = state.coverage.survivorRuns;
  const changed = regen.changedSpecFiles ?? [];
  if (regen.outcome !== "accepted" || routed.length === 0 || changed.length === 0 || !deps.objectiveSignal.recheckSurvivors) return undefined;
  const changedSet = new Set(changed);
  const baselineCases = regen.run.cases.filter((c) => c.status === "pass" && changedSet.has(c.file ?? c.name)).map((c) => c.name);
  const result = baselineCases.length > 0 ? await recheckOrNone(() => deps.objectiveSignal.recheckSurvivors!(survivorRechecks(routed, changed), workspace.specDir, `${input.runId}-closure`, baselineCases)) : null;
  const closure = survivorClosureOf(routed.length, result);
  engineLog.info(`[qa] survivor closure: ${closure.closed} of ${closure.routed} surviving mutant(s) now noticed by a test (${closure.judged} judged)`);
  return closure;
}

/*
 * The coverage after a gap regeneration, counted again from the dumps on disk when it was accepted: the arms and lines the reviewer
 * and the record describe are then the delivered bytes'. Under enforce only the final whole-suite re-measure decides, so the recount
 * informs and never touches the decision; under signal it is the measurement, and only the value score stays stale. Without a recount
 * the arms are not current.
 */
export async function recountAfter(state: Readonly<RunState>, ctx: WorkspaceRunContext, regen: GapRegeneration): Promise<CoverageOutcome> {
  const { deps, input, cfg, workspace } = ctx;
  const spent = withAcceptanceCalls(state.coverage, regen.acceptanceCalls);
  if (regen.outcome !== "accepted") return spent;
  /* Every accepted regeneration's re-runs are carried, so a recount reads each rewritten spec from the dumps of the bytes now delivered, not only the current regeneration's. */
  const reruns = [...state.coverage.reruns, ...(regen.reruns ?? [])];
  const accepted = { ...acceptedRegeneration(spent), reruns };
  /* The fix loop's re-runs come first: the measurement read them over the same namespace. */
  const { coverageNamespace, coverageReruns } = state.fixLoop;
  const recount =
    regen.reruns && deps.objectiveSignal.recount
      ? await deps.objectiveSignal.recount(BlastRadius.of(input.sha, state.classification.intent?.changedFiles ?? []), workspace.specDir, state.classification.diff, [...coverageReruns, ...reruns], {
          ...(coverageNamespace ? { namespace: coverageNamespace } : {}),
          ...(state.coverage.mutantProofs.length > 0 ? { proofs: state.coverage.mutantProofs } : {}),
          ...(state.coverage.exclusions ? { exclusions: state.coverage.exclusions } : {}),
          caseFiles: passingCaseFiles(regen.run.cases),
        })
      : null;
  if (!recount) return { ...accepted, untakenArmsCurrent: false };
  const arms: CoverageOutcome = { ...accepted, uncovered: recount.uncovered, untakenArms: recount.untakenArms, untakenArmsCurrent: true, ranBy: recount.ranBy, branchCoverage: branchCoverageOf(recount.measurement), changeCoverage: changeCoverageOf(recount.measurement) ?? accepted.changeCoverage };
  if (cfg.coveragePolicyMode !== "signal") return arms;
  return {
    ...remeasured(arms),
    coverageRatio: recount.ratio,
    coverageStatus: recount.status,
    valueStale: state.coverage.valueScore !== null || state.coverage.valueStale,
  };
}

/* The spec files of the passing cases of an execution. */
function passingCaseFiles(cases: ReturnType<typeof runOf>["cases"]): string[] {
  return [...new Set(cases.flatMap((c) => (c.status === "pass" && c.file ? [c.file] : [])))];
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
 * is the breadth of the gap, and the lead's turn gives them up as references to their files only when its window cannot hold them.
 */
export function gapUnits(uncovered: CoverageOutcome["uncovered"], arms: CoverageOutcome["untakenArms"], candidates: RunState["grounding"]["candidates"], ranBy: CoverageOutcome["ranBy"] = []): GapUnit[] {
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
      const text = `decision arm on a changed line that NO test ran: ${u.file}:${u.line} ${u.kind}: ${u.arm}`;
      return { text, finding: { text, file: u.file, line: u.line, ...ran(u.file) } };
    }),
  ];
}

/*
 * The findings of a gap: one per unit, carrying the file it names so the orchestrator routes it by the use case that file seeds, then
 * one per surviving mutant and spec that reached it, carrying that spec so the lead's pass hands it to the flow that owns the spec; a
 * mutant no spec is recorded as reaching has no owner and is told to the lead as it is. A gap with neither units nor survivors is
 * read whole as one finding; an empty one gives none.
 */
export function gapFindings(gap: string, units: readonly GapUnit[], survived: readonly SurvivedMutant[]): EvidenceFinding[] | undefined {
  const findings: EvidenceFinding[] = [
    ...(units.length > 0 ? units.map((u) => ({ finding: u.finding })) : survived.length > 0 && gap ? [{ finding: { text: gap } }] : []),
    ...survived.flatMap((m) =>
      (m.specFiles && m.specFiles.length > 0 ? m.specFiles : [undefined]).map((spec) => ({ finding: { text: renderSurvivedMutant(m, spec), ...(spec ? { spec } : {}) } })),
    ),
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

/* A regeneration at the coverage gap: its units routed by the file each names, the surviving mutants by the spec that reached them; an author that has no lead reads the gap whole, survivors included. */
function regenerateAtCoverageGap(state: Readonly<RunState>, ctx: WorkspaceRunContext, base: string, units: readonly GapUnit[], survived: readonly SurvivedMutant[]): Promise<GapRegeneration> {
  const gap = [base, renderSurvivedMutants(survived)].filter(Boolean).join("\n\n");
  return regenerateAtGap(state, ctx, { coverageGap: gap, coverageGapReference: gapReference(units, survived), coverageGapItems: units.map((u) => u.text) }, CORRECTION_ORIGIN.COVERAGE, gapFindings(base, units, survived));
}

/* Enforce-mode one-shot coverage regeneration at the uncovered lines and the arms no test ran; it runs at most once per run and is independent of the FixLoop budget. The whole-suite re-measure that decides coverage is the single final re-measure before decide. */
export async function regenerateForCoverage(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { uncovered, untakenArms } = state.coverage;
  const survived = survivorsOf(state);
  const gap = [renderCoverageGap(uncovered, state.grounding.candidates), renderBranchGap(untakenArms)].filter(Boolean).join("\n\n");
  const regen = await regenerateAtCoverageGap(state, ctx, gap, gapUnits(uncovered, untakenArms, state.grounding.candidates, state.coverage.ranBy), survived);
  const survivorClosure = await closeSurvivors(state, ctx, regen);
  const coverage = await recountAfter(state, ctx, regen);
  return { update: { execution: withRun(state.execution, regen.run), coverage: { ...coverage, ...(survivorClosure ? { survivorClosure } : {}) }, loops: { ...state.loops, coverageRegen: state.loops.coverageRegen + 1, leadCorrections: state.loops.leadCorrections + regen.leadCorrections } } };
}

/* The one regeneration from the arms of the changed code no test ran and the mutants no test noticed: they are the cases still missing. It never blocks; what it did is recorded with the arms before and after it. */
export async function regenerateForBranchCases(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const armsBefore = state.coverage.untakenArms.length;
  const survived = survivorsOf(state);
  const regen = await regenerateAtCoverageGap(state, ctx, renderBranchGap(state.coverage.untakenArms), gapUnits([], state.coverage.untakenArms, [], state.coverage.ranBy), survived);
  const survivorClosure = await closeSurvivors(state, ctx, regen);
  const coverage = await recountAfter(state, ctx, regen);
  const armsAfter = regen.outcome !== "accepted" ? armsBefore : coverage.untakenArmsCurrent ? coverage.untakenArms.length : undefined;
  return {
    update: {
      execution: withRun(state.execution, regen.run),
      coverage: { ...coverage, ...(survivorClosure ? { survivorClosure } : {}), branchCases: { outcome: regen.outcome, armsBefore, ...(armsAfter !== undefined ? { armsAfter } : {}), ...regen.files } },
      loops: { ...state.loops, leadCorrections: state.loops.leadCorrections + regen.leadCorrections },
    },
  };
}
