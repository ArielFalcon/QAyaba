/* The coverage phase of a run: the change-coverage measurement of a green execution and, in enforce mode, the one regeneration at the uncovered lines. */

import { CORRECTION_ORIGIN } from "@contexts/coordination/application/index.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { renderCoverageGap } from "@contexts/objective-signal/application/index.ts";
import type { StepOutcome } from "../run-flow.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import { runOf, type RunState } from "../run-state.ts";
import { acceptedRegeneration, rollbackDelivered, withAcceptanceCalls, withRun } from "../reducers.ts";
import { executeAccepted, validateAccepted } from "./execute.steps.ts";
import { regenerate } from "./generation-services.ts";
import { coverageRegenAction } from "../../../domain/coverage-regen.ts";

type Result = Promise<StepOutcome<RunState>>;

/* A context run executes nothing (its pass is synthetic), so it has no coverage or value to measure. */
export const measuresCoverage = (state: Readonly<RunState>, ctx: WorkspaceRunContext): boolean => runOf(state).verdict === "pass" && ctx.input.mode !== "context";

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
    console.log(`[qa] change-coverage: skipped — the changed lines live in ${input.triggerRepo}; browser coverage maps only the frontend (status=unknown).`);
  }
  /* This pass's own passing case names — the green baseline the fault-injection oracle needs. */
  const baselineCases = run.cases.filter((c) => c.status === "pass").map((c) => c.name);
  const { coverageNamespace } = state.fixLoop;
  const signal = await deps.objectiveSignal.measure(
    runBlastRadius,
    workspace.specDir,
    input.triggerRepo ? undefined : diff,
    baselineCases,
    ...(coverageNamespace ? [{ namespace: coverageNamespace }] : []),
  );
  return {
    update: {
      coverage: {
        ...state.coverage,
        coverageRatio: signal.ratio,
        coverageStatus: signal.status,
        coverageMeasured: measuresPerCommit(ctx),
        valueScore: signal.valueScore ?? null,
        mutantCount: signal.mutantCount ?? undefined,
        killedCount: signal.killedCount ?? undefined,
        uncovered: signal.uncovered ?? [],
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

/*
 * Enforce-mode one-shot coverage regen: this step runs at most once per run and is independent of the FixLoop budget. A regen
 * throw propagates; a spent run deadline is the one the policy degrades (this step runs after a green suite), so the first
 * measurement stands. The regen's changed specs go through acceptance: they execute green (or reuse a proof) before they stand.
 * A rejected or capped regen keeps the first measurement and restores the prior bytes. The whole-suite re-measure that decides
 * coverage is the single final re-measure before decide.
 */
export async function regenerateForCoverage(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { input, trail, workspace, services } = ctx;
  const { acceptance, integrityCounters, snapshotPort, runDeadlinePort, suiteChangedFiles, snapshotSuite, acceptanceScope } = services;
  let { acceptanceCalls } = state.coverage;
  let coverage = state.coverage;
  let run = runOf(state);
  const gap = renderCoverageGap(state.coverage.uncovered);
  const snapshot = await snapshotSuite();
  /* mutation-scope:begin delivered-before-coverage-regen */
  const deliveredBefore = state.generation.delivered;
  /* mutation-scope:end delivered-before-coverage-regen */
  const regenerated = await regenerate(state, ctx, undefined, { coverageGap: gap }, CORRECTION_ORIGIN.COVERAGE);
  const regen = regenerated.output;
  const { leadCorrections } = regenerated;
  await services.confinement.enforce();
  const changedFiles = await suiteChangedFiles(snapshot, regen.specs);
  const changedSpecFiles = acceptanceScope(changedFiles);
  if (regen.specs.length === 0) {
    /* A coverage turn that delivers no specs is not a change to accept: whatever it wrote is put back. */
    if (changedFiles.length > 0) {
      await snapshotPort.restore(workspace.specDir, snapshot, changedFiles.filter((file) => !snapshot.files.has(file)));
    }
    rollbackDelivered(state, deliveredBefore);
  } else if (changedSpecFiles.length > 0) {
    const { closedLoop } = trail;
    const outcome = await acceptance.accept({
      specDir: workspace.specDir,
      changedSpecFiles,
      namespace: `${input.runId}-acc${acceptanceCalls++}`,
      snapshot,
      ...(closedLoop ? { closedLoop } : {}),
      deadline: runDeadlinePort,
      validate: validateAccepted(state, ctx),
      execute: executeAccepted(ctx),
    });
    if (outcome.kind === "accepted") {
      integrityCounters.acceptances += 1;
      if (outcome.executedSpecs.length === 0) integrityCounters.proofReused += 1;
      coverage = acceptedRegeneration(coverage);
      if (outcome.execution?.cases.length) {
        const changedSet = new Set(changedSpecFiles);
        run = { ...run, cases: [...run.cases.filter((c) => !changedSet.has(c.file ?? c.name)), ...outcome.execution.cases] };
      }
    } else {
      /* Rejected or capped: the turn's specs are not the run's. */
      rollbackDelivered(state, deliveredBefore);
      if (outcome.kind === "rejected") integrityCounters.rejected += 1;
      else integrityCounters.capHit = true;
      /* The first measurement and the prior bytes stand. */
    }
  }
  return { update: { execution: withRun(state.execution, run), coverage: withAcceptanceCalls(coverage, acceptanceCalls), loops: { ...state.loops, coverageRegen: state.loops.coverageRegen + 1, leadCorrections: state.loops.leadCorrections + leadCorrections } } };
}
