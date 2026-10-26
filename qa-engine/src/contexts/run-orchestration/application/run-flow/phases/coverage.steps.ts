/* The coverage phase of a run: the change-coverage measurement of a green execution and at most one regeneration at its gap: in enforce mode at the uncovered lines (with the arms no test ran), otherwise, with the branch cases on, at the arms no test ran. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import { CORRECTION_ORIGIN } from "@contexts/coordination/application/index.ts";
import { faultAimOf } from "../fault-aim.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { renderBranchGap, renderCoverageGap, type CoverageMeasurement, type CoverageRerun } from "@contexts/objective-signal/application/index.ts";
import type { StepOutcome } from "../run-flow.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import { runOf, type BranchCasesOutcome, type CoverageOutcome, type RunState } from "../run-state.ts";
import { acceptedRegeneration, remeasured, rollbackDelivered, withAcceptanceCalls, withRun } from "../reducers.ts";
import { executeAccepted, validateAccepted } from "./execute.steps.ts";
import { regenerate } from "./generation-services.ts";
import { branchCasesAction, coverageRegenAction } from "../../../domain/coverage-regen.ts";

type Result = Promise<StepOutcome<RunState>>;

/* A context run executes nothing (its pass is synthetic), so it has no coverage or value to measure. */
export const measuresCoverage = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean => runOf(state).verdict === "pass" && ctx.input.mode !== "context";

/* The arms of the decisions on changed lines a measurement counted, and how many ran; undefined when it saw none. */
export const branchCoverageOf = (m: CoverageMeasurement | undefined): CoverageOutcome["branchCoverage"] =>
  m?.changedBranches !== undefined ? { changed: m.changedBranches, taken: m.takenBranches ?? 0 } : undefined;

/* Only a diff run on one repo measures a real per-commit coverage signal. */
const measuresPerCommit = (ctx: WorkspaceRunContext): boolean => ctx.input.mode === "diff" && !ctx.input.triggerRepo;

/* The step is announced only when this pass actually measures per commit; a pass that never measured does not emit it. */
export const announcesCoverage = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean => measuresCoverage(state, ctx) && measuresPerCommit(ctx);

export async function announceCoverage(_state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  ctx.deps.observer?.onStep("coverage");
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
  /* The spec files of those cases: a mutant re-runs the ones whose tests reached it. */
  const caseFiles = [...new Set(passed.flatMap((c) => (c.file ? [c.file] : [])))];
  const { coverageNamespace } = state.fixLoop;
  /* The response oracle corrupts only the operations the change reaches; with no scope it has nothing to corrupt. */
  const faultAim = faultAimOf({ scope: state.grounding.changeScope, candidates: state.grounding.candidates, flowCandidates: state.generation.flowCandidates });
  const signal = await deps.objectiveSignal.measure(
    runBlastRadius,
    workspace.specDir,
    input.triggerRepo ? undefined : diff,
    baselineCases,
    ...(coverageNamespace || caseFiles.length > 0 || state.grounding.candidates.length > 0 || faultAim !== undefined
      ? [{
          ...(coverageNamespace ? { namespace: coverageNamespace } : {}),
          ...(caseFiles.length > 0 ? { caseFiles } : {}),
          ...(state.grounding.candidates.length > 0 ? { candidates: state.grounding.candidates } : {}),
          ...(input.triggerRepo ? { crossRepo: true } : {}),
          ...(faultAim ? { faultAim } : {}),
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

/* Whether the branch-case regeneration runs: arms of the changed code no test ran, on a per-commit diff whose measurement blocks nothing (a blocking one regenerates for coverage, with the same arms in its gap), with the branch cases on. */
export const regeneratesForBranchCases = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean =>
  branchCasesAction({
    measured: measuresCoverage(state, ctx),
    blocks: state.coverage.blocksPublish,
    perCommit: measuresPerCommit(ctx),
    enabled: ctx.cfg.coverageBranchCases === "regenerate",
    untakenArms: state.coverage.untakenArms.length,
  }) === "regenerate";

/* How a gap regeneration ended; `reruns` names the acceptance's own dumps when every spec it changed executed in it, so the coverage can be recounted from them. */
interface GapRegeneration {
  outcome: BranchCasesOutcome["outcome"];
  run: NonNullable<RunState["execution"]["run"]>;
  acceptanceCalls: number;
  leadCorrections: number;
  reruns?: CoverageRerun[];
}

/*
 * One regeneration at a gap of the change: its changed specs go through acceptance, so they execute green (or reuse a proof) before
 * they stand. A turn that delivers nothing, or whose specs are rejected or capped, keeps the first measurement and restores the prior
 * bytes. A throw propagates; a spent run deadline is the one the policy degrades (this step runs after a green suite), so the first
 * measurement stands.
 */
async function regenerateAtGap(state: Readonly<RunState>, ctx: WorkspaceRunContext, gap: string, items: readonly string[]): Promise<GapRegeneration> {
  const { input, trail, workspace, services } = ctx;
  const { acceptance, integrityCounters, snapshotPort, runDeadlinePort, suiteChangedFiles, snapshotSuite, acceptanceScope } = services;
  let { acceptanceCalls } = state.coverage;
  let run = runOf(state);
  const snapshot = await snapshotSuite();
  /* mutation-scope:begin delivered-before-coverage-regen */
  const deliveredBefore = state.generation.delivered;
  /* mutation-scope:end delivered-before-coverage-regen */
  const regenerated = await regenerate(state, ctx, undefined, { coverageGap: gap, coverageGapItems: items }, CORRECTION_ORIGIN.COVERAGE);
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
    return { outcome: outcome.kind === "rejected" ? "rejected" : "capped", run, acceptanceCalls, leadCorrections };
  }
  integrityCounters.acceptances += 1;
  if (outcome.executedSpecs.length === 0) integrityCounters.proofReused += 1;
  if (outcome.execution?.cases.length) {
    const changedSet = new Set(changedSpecFiles);
    run = { ...run, cases: [...run.cases.filter((c) => !changedSet.has(c.file ?? c.name)), ...outcome.execution.cases] };
  }
  /* A spec whose proof was reused left no dumps here: the coverage cannot be recounted without it. */
  const executed = new Set(outcome.executedSpecs);
  const recountable = changedSpecFiles.every((file) => executed.has(file));
  return { outcome: "accepted", run, acceptanceCalls, leadCorrections, ...(recountable ? { reruns: [{ namespace, specFiles: changedSpecFiles }] } : {}) };
}

/*
 * The coverage after a gap regeneration, counted again from the dumps on disk when it was accepted: the arms and lines the reviewer
 * and the record describe are then the delivered bytes'. Under enforce only the final whole-suite re-measure decides, so the recount
 * informs and never touches the decision; under signal it is the measurement, and only the value score stays stale. Without a recount
 * the arms are not current.
 */
async function recountAfter(state: Readonly<RunState>, ctx: WorkspaceRunContext, regen: GapRegeneration): Promise<CoverageOutcome> {
  const { deps, input, cfg, workspace } = ctx;
  const spent = withAcceptanceCalls(state.coverage, regen.acceptanceCalls);
  if (regen.outcome !== "accepted") return spent;
  const accepted = acceptedRegeneration(spent);
  const { coverageNamespace } = state.fixLoop;
  const recount =
    regen.reruns && deps.objectiveSignal.recount
      ? await deps.objectiveSignal.recount(BlastRadius.of(input.sha, state.classification.intent?.changedFiles ?? []), workspace.specDir, state.classification.diff, regen.reruns, coverageNamespace ? { namespace: coverageNamespace } : {})
      : null;
  if (!recount) return { ...accepted, untakenArmsCurrent: false };
  const arms: CoverageOutcome = { ...accepted, uncovered: recount.uncovered, untakenArms: recount.untakenArms, untakenArmsCurrent: true, branchCoverage: branchCoverageOf(recount.measurement) };
  if (cfg.coveragePolicyMode !== "signal") return arms;
  return {
    ...remeasured(arms),
    coverageRatio: recount.ratio,
    coverageStatus: recount.status,
    valueStale: state.coverage.valueScore !== null || state.coverage.valueStale,
  };
}

/* The most units of a gap the lead is shown, as many as the gap text lists of each kind. */
const MAX_GAP_FILES = 10;
const MAX_GAP_ARMS = 20;

/*
 * The gap as separate units, one per file with uncovered changed lines and one per decision arm no test ran: the lead routes findings
 * by number, so each number must name one unit it can hand to a flow.
 */
function gapUnits(uncovered: CoverageOutcome["uncovered"], arms: CoverageOutcome["untakenArms"], candidates: RunState["grounding"]["candidates"]): string[] {
  return [
    ...uncovered.slice(0, MAX_GAP_FILES).map((u) => renderCoverageGap([u], undefined, candidates)),
    ...arms.slice(0, MAX_GAP_ARMS).map((u) => `decision arm on a changed line that NO test ran: ${u.file}:${u.line} ${u.kind}: ${u.arm}`),
  ];
}

/* Enforce-mode one-shot coverage regeneration at the uncovered lines and the arms no test ran; it runs at most once per run and is independent of the FixLoop budget. The whole-suite re-measure that decides coverage is the single final re-measure before decide. */
export async function regenerateForCoverage(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { uncovered, untakenArms } = state.coverage;
  const gap = [renderCoverageGap(uncovered, undefined, state.grounding.candidates), renderBranchGap(untakenArms)].filter(Boolean).join("\n\n");
  const regen = await regenerateAtGap(state, ctx, gap, gapUnits(uncovered, untakenArms, state.grounding.candidates));
  return { update: { execution: withRun(state.execution, regen.run), coverage: await recountAfter(state, ctx, regen), loops: { ...state.loops, coverageRegen: state.loops.coverageRegen + 1, leadCorrections: state.loops.leadCorrections + regen.leadCorrections } } };
}

/* The one regeneration from the arms of the changed code no test ran: they are the cases still missing. It never blocks; what it did is recorded with the arms before and after it. */
export async function regenerateForBranchCases(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const armsBefore = state.coverage.untakenArms.length;
  const regen = await regenerateAtGap(state, ctx, renderBranchGap(state.coverage.untakenArms), gapUnits([], state.coverage.untakenArms, []));
  const coverage = await recountAfter(state, ctx, regen);
  const armsAfter = regen.outcome !== "accepted" ? armsBefore : coverage.untakenArmsCurrent ? coverage.untakenArms.length : undefined;
  return {
    update: {
      execution: withRun(state.execution, regen.run),
      coverage: { ...coverage, branchCases: { outcome: regen.outcome, armsBefore, ...(armsAfter !== undefined ? { armsAfter } : {}) } },
      loops: { ...state.loops, leadCorrections: state.loops.leadCorrections + regen.leadCorrections },
    },
  };
}
