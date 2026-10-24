/*
 * What the generation of a run needs from more than one phase: the work that follows every generation by the lead, the question
 * of whether the run_spec loop has done the work a regeneration would repeat, and one regeneration over what the run has delivered.
 * They are behavior, so they are functions of the run's context and state; the specs delivered so far are the one mutable fact,
 * held on `ctx.generation`.
 */

import { normalizeSpecPath } from "@kernel/spec-path.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import type { ClosedLoopGateSignal } from "@kernel/closed-loop.ts";
import type { GeolocationFacts } from "@kernel/geolocation.ts";
import { PROBE_REL_DIR } from "@contexts/test-execution/domain/run-spec-capability.ts";
import { mergeDeliveredSpecs } from "../../../domain/helpers/delivered-specs.ts";
import type { GenerationEnrichment, GenerationOutput } from "../../ports/index.ts";
import type { CoordinatedPass } from "../../coordination/lead-sidekicks.ts";
import type { ReviewerFinding } from "../../coordination/lead-correction.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import type { RunState } from "../run-state.ts";

/* A probe is a throwaway spec the generator ran through run_spec: it lives under the probe directory and is never a deliverable. */
function isProbeSpec(file: string): boolean {
  return normalizeSpecPath(file).split("/").includes(PROBE_REL_DIR);
}

/* The generation without the probes it listed as deliverables; the same object when it listed none. */
export function withoutProbeSpecs<T extends Pick<GenerationOutput, "specs" | "declaredSpecs">>(output: T): T {
  if (!output.specs.some(isProbeSpec) && !(output.declaredSpecs ?? []).some((d) => isProbeSpec(d.file))) return output;
  return {
    ...output,
    specs: output.specs.filter((file) => !isProbeSpec(file)),
    ...(output.declaredSpecs ? { declaredSpecs: output.declaredSpecs.filter((d) => !isProbeSpec(d.file)) } : {}),
  };
}

/* The probes the generator left in the working copy could not be removed. */
export class ProbeSweepError extends Error {
  constructor(reason: string) {
    super(`the run_spec probes could not be removed from the working copy (${reason})`);
    this.name = "ProbeSweepError";
  }
}

export const geolocationEnrichment = (ctx: WorkspaceRunContext): { geolocation?: GeolocationFacts } =>
  ctx.trail.geolocation ? { geolocation: ctx.trail.geolocation.facts() } : {};

/* What follows every generation by the lead: the probes it left behind are swept before anything looks at the working copy, and none is a deliverable. Without a loop, the generation is returned as it is. */
export async function afterGeneration<T extends Pick<GenerationOutput, "specs" | "declaredSpecs">>(ctx: WorkspaceRunContext, output: T): Promise<T> {
  const { closedLoop } = ctx.trail;
  if (!closedLoop) return output;
  try {
    await closedLoop.sweepProbes();
  } catch (err) {
    /* Fail closed: a working copy that may still hold throwaway specs is not validated, executed or published. The run ends as an infra-error (runInScope). */
    throw new ProbeSweepError(err instanceof Error ? err.message : String(err));
  }
  return withoutProbeSpecs(output);
}

/* Whether every delivered spec was seen passing in the bytes it has now: the generator has already done the work a regeneration would repeat. A fault in asking is "not closed", which keeps every regeneration. */
export async function loopClosedNow(ctx: WorkspaceRunContext): Promise<boolean> {
  const { closedLoop } = ctx.trail;
  const { delivered } = ctx.generation;
  if (!closedLoop || delivered.length === 0) return false;
  try {
    return await closedLoop.isClosed(delivered.map((d) => d.file));
  } catch (err) {
    console.error(`[qa] could not tell whether the run_spec loop is closed (regenerations stay on): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function closedLoopSignal(ctx: WorkspaceRunContext): Promise<ClosedLoopGateSignal | undefined> {
  const { closedLoop } = ctx.trail;
  return closedLoop ? { ...closedLoop.signals(), closed: await loopClosedNow(ctx) } : undefined;
}

/* One regeneration by the lead over what the run has delivered so far; what it delivers joins that. */
export async function regenerate(state: Readonly<RunState>, ctx: WorkspaceRunContext, regenerationSignal: AbortSignal | undefined, enrichment: GenerationEnrichment): Promise<GenerationOutput> {
  const { deps, workspace, generation } = ctx;
  const regenerated = await afterGeneration(ctx, await deps.generation.generate([], workspace.specDir, regenerationSignal, state.classification.diff, {
    ...state.grounding.baseEnrichment,
    ...geolocationEnrichment(ctx),
    ...enrichment,
    ...(generation.delivered.length > 0 ? { deliveredSpecs: generation.delivered } : {}),
  }));
  generation.delivered = mergeDeliveredSpecs(generation.delivered, regenerated, "lead");
  return regenerated;
}

/*
 * The reviewer's corrections in a coordinated run: the lead routes them to the sidekicks of its flows, which correct their specs
 * in their own sessions; a finding no flow was sent goes to a regeneration, as in a run the lead authored alone. What both
 * deliver joins the run's delivery and goes through the round's acceptance like any regeneration.
 */
export async function correctThroughLead(
  state: Readonly<RunState>,
  ctx: WorkspaceRunContext,
  pass: CoordinatedPass,
  findings: readonly ReviewerFinding[],
  regenerationSignal: AbortSignal | undefined,
): Promise<GenerationOutput> {
  const corrected = await pass.correct(findings);
  /* Recorded after every turn, so however the run ends from here what the lead routed is on its record. */
  ctx.ends.recordCorrections();
  const byFlows = await afterGeneration(ctx, {
    specs: corrected.specs,
    end: corrected.specs.length > 0 ? GENERATION_END.DELIVERED : GENERATION_END.UNDECIDED_EMPTY,
    reviewed: false,
    approved: true,
    parsed: corrected.readable,
  } satisfies GenerationOutput);
  ctx.generation.delivered = mergeDeliveredSpecs(ctx.generation.delivered, byFlows, "sidekick");
  const regenerated = corrected.unrouted.length > 0 ? await regenerate(state, ctx, regenerationSignal, { reviewCorrections: corrected.unrouted }) : undefined;
  const rebuttals = [...corrected.rebuttals, ...(regenerated?.rebuttals ?? [])];
  const specs = [...new Set([...byFlows.specs, ...(regenerated?.specs ?? [])])];
  return { ...(regenerated ?? byFlows), specs, end: specs.length > 0 ? GENERATION_END.DELIVERED : (regenerated?.end ?? byFlows.end), ...(rebuttals.length > 0 ? { rebuttals } : {}) };
}
