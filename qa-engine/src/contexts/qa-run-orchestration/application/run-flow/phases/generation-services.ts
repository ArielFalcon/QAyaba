/*
 * What the generation of a run needs from more than one phase: the work that follows every generation by the lead, the question
 * of whether the run_spec loop has done the work a regeneration would repeat, and one regeneration over what the run has delivered.
 * They are behavior, so they are functions of the run's context and state; the specs delivered so far are the one mutable fact,
 * held on `ctx.generation`.
 */

import { normalizeSpecPath } from "@kernel/spec-path.ts";
import type { ClosedLoopGateSignal } from "@kernel/closed-loop.ts";
import type { GeolocationFacts } from "@kernel/geolocation.ts";
import { PROBE_REL_DIR } from "@contexts/test-execution/domain/run-spec-capability.ts";
import { mergeDeliveredSpecs } from "../../../domain/helpers/delivered-specs.ts";
import type { GenerationEnrichment, GenerationOutput } from "../../ports/index.ts";
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
