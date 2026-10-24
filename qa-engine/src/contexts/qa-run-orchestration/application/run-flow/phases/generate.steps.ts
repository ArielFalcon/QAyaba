/* The generate phase of a run: the agent writes the specs (or the lead/sidekick mode authors them as flows), the way the generation ended decides whether the run goes on, and the pre-exec grounding may ask for one corrective regeneration before the static gate. */

import { relative } from "node:path";
import { COORDINATION_MODE, DEFAULT_COORDINATION_SETTINGS, effectiveCoordinationMode } from "@kernel/coordination.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { NOOP_KIND } from "@kernel/noop-kind.ts";
import { rethrowIfRunDeadline } from "../../../../../shared-kernel/run-deadline.ts";
import { attributeContradictions } from "../../../domain/helpers/contradiction-attribution.ts";
import { engineSideCauseOf, terminalForGenerationEnd } from "../../../domain/helpers/generation-end-terminal.ts";
import { mergeDeliveredSpecs } from "../../../domain/helpers/delivered-specs.ts";
import { checkPreExecGrounding } from "../../../domain/pre-exec-grounding.service.ts";
import { detectArchetype } from "@contexts/cross-run-learning/domain/distill-rule.ts";
import { reviewerApprovalOf } from "../../ports/index.ts";
import type { GenerationOutput } from "../../ports/index.ts";
import type { CoordinateResult } from "../../coordination/lead-sidekicks.ts";
import { evidenceFromPackDataRoutes } from "../../coordination/evidence-from.ts";
import type { RunQaResult } from "../../run-qa.use-case.ts";
import type { StepResult } from "../run-flow.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import type { RunState } from "../run-state.ts";
import { afterGeneration, closedLoopSignal, geolocationEnrichment, loopClosedNow, regenerate } from "./generation-services.ts";

type Result = Promise<StepResult<RunState, RunQaResult>>;

/*
 * The lead/sidekick mode: the lead is asked for a plan and its flows are authored by sidekicks, each in a workspace of its own.
 * What comes back is a generation like any other: the specs of the flows that delivered, a declared no-op, or an end that
 * names why nothing was finished. Undefined: the lead authors the change in one turn, as every run did before this mode.
 * The mode is the app's setting unless the run chose; a code run, a context run and a login still to be written never use it.
 */
async function coordinateFirstPass(state: Readonly<RunState>, ctx: WorkspaceRunContext): Promise<GenerationOutput | undefined> {
  const { deps, input, cfg, workspace, signal } = ctx;
  const { closedLoop, agentBrowser, geolocation } = ctx.trail;
  const { generating, intent: classificationIntent, diff: classificationDiff } = state.classification;
  const { authSeedUnauthored } = state.setup;
  const { baseEnrichment } = state.grounding;
  const coordinationSettings = deps.coordinationSettings ?? DEFAULT_COORDINATION_SETTINGS;
  const coordinationMode = effectiveCoordinationMode(coordinationSettings, input.coordinationMode);
  if (coordinationMode !== COORDINATION_MODE.LEAD_SIDEKICKS || !deps.leadSidekicks) return undefined;
  if (!generating || cfg.isCode || input.mode === "context" || authSeedUnauthored) return undefined;
  let result: CoordinateResult;
  try {
    result = await deps.leadSidekicks.coordinate({
      runId: input.runId,
      app: input.app,
      objective: input.guidance ?? classificationIntent?.message ?? `QA run ${input.runId}`,
      mirrorDir: workspace.mirrorDir,
      specDir: workspace.specDir,
      specRelDir: relative(workspace.mirrorDir, workspace.specDir).replace(/\\/g, "/") || "e2e",
      settings: { ...coordinationSettings, mode: coordinationMode },
      facts: { hasLogin: Boolean(deps.authContext?.auth), provider: deps.sidekickProvider?.(), plannerProvider: deps.plannerProvider?.() },
      ...(closedLoop ? { closedLoop } : {}),
      ...(agentBrowser ? { agentBrowser } : {}),
      ...(geolocation ? { geolocation } : {}),
      ...(deps.sidekickDevBaseUrl ? { devBaseUrl: deps.sidekickDevBaseUrl } : {}),
      /* The pages the pack read with results: every sidekick's brief states them, and a flow's empty read of one is checked against them. */
      ...(state.grounding.confirmedDataRoutes?.length ? { knownFacts: evidenceFromPackDataRoutes(state.grounding.confirmedDataRoutes) } : {}),
      ...(state.grounding.contextPack ? { contextPack: state.grounding.contextPack } : {}),
      ...(deps.generation.plan
        ? { plan: (planning) => deps.generation.plan!(workspace.specDir, signal, classificationDiff, { ...baseEnrichment, ...geolocationEnrichment(ctx), planning }) }
        : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    rethrowIfRunDeadline(err);
    console.error(`[qa] coordination failed (the lead authors the change alone): ${err instanceof Error ? err.message : String(err)}`);
    ctx.ends.recordCoordination({ mode: COORDINATION_MODE.LEAD_SIDEKICKS, downgrade: "coordination failed", flows: 0, delivered: 0, incomplete: 0, takeover: false });
    return undefined;
  }
  ctx.ends.recordCoordination(result.signal);
  if (result.action === "single") return undefined;
  if (result.action === "noop") {
    /* A plan names no kind of no-op. */
    return { specs: [], end: GENERATION_END.DECLARED_NOOP, noopKind: NOOP_KIND.UNSPECIFIED, reviewed: false, approved: true, parsed: true, note: result.reason };
  }
  const { aggregated } = result;
  /* Kept open for the reviewer's corrections only when the flows delivered: nothing else reaches a review. */
  if (result.pass) {
    if (aggregated.end === GENERATION_END.DELIVERED) ctx.trail.coordinatedPass = result.pass;
    else await result.pass.release().catch((err: unknown) => console.error(`[qa] releasing the coordinated pass failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  if (aggregated.end !== GENERATION_END.DELIVERED) {
    return { specs: [], end: aggregated.end, reviewed: false, approved: true, parsed: true, ...(aggregated.note ? { note: aggregated.note } : {}) };
  }
  const unfinished = aggregated.incompleteFlows.map((f) => `${f.id} (${f.kind})`).join(", ");
  if (unfinished) deps.observer?.onEvent({ type: "log.line", level: "warn", text: `coordination: ${aggregated.incompleteFlows.length} flow(s) did not finish: ${unfinished}` });
  return await afterGeneration(ctx, { specs: aggregated.specs, end: GENERATION_END.DELIVERED, reviewed: false, approved: true, parsed: true, ...(unfinished ? { note: `flows that did not finish: ${unfinished}` } : {}) });
}

/*
 * Skipped when generating is false (regression) — the synthetic empty approved
 * result is not a GenerationPort call.
 * In the lead/sidekick mode the flows' specs stand in for the lead's first pass (coordinateFirstPass).
 */
export async function generateFirstPass(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, workspace, signal, generation } = ctx;
  const { generating, diff: classificationDiff } = state.classification;
  const { authSeedUnauthored } = state.setup;
  const { baseEnrichment } = state.grounding;
  deps.observer?.onStep("generate", generating ? undefined : "regression: running the existing suite, not generating");
  /* A regression run generates nothing: a stand-in with no generation end, never one a generation could return. */
  let generated = state.generation.generated;
  if (!generating) {
    generated = { specs: [], approved: true, reviewed: false, end: null };
  } else {
    /*
     * A stock seed that did not sign in reaches the generator as its own fact in every mode (the
     * prompt builders render the rewrite instruction); the Context Pack stays grounding-only.
     * The coordination does not engage for such a run (coordinateFirstPass): sidekick output from the login wall is
     * not the session the suite will run with.
     */
    const coordinatedFirstPass = await coordinateFirstPass(state, ctx);
    if (signal?.aborted) return { end: await ctx.ends.aborted(workspace.mirrorDir) };
    generated = coordinatedFirstPass
      ?? (await afterGeneration(ctx, await deps.generation.generate([], workspace.specDir, signal, classificationDiff, {
        ...baseEnrichment,
        ...geolocationEnrichment(ctx),
        ...(authSeedUnauthored ? { authSeedUnauthored: true } : {}),
      })));
    generation.delivered = mergeDeliveredSpecs(generation.delivered, generated, coordinatedFirstPass ? "sidekick" : "lead");
  }
  /*
   * Confinement after a real generate() only. The regression synthetic stand-in
   * wrote nothing. Sidekick writes are still agent writes.
   */
  if (generating) await ctx.services.confinement.enforce();
  return { update: { generation: { ...state.generation, generated } } };
}

/*
 * How the generation ended decides how the run does. With specs the run continues (a generation
 * that also ran out of steps is only logged). Without specs only a declared no-op is a decision
 * and skips; running out of steps, or a verdict that decides nothing, ends the run as a persisted
 * infra-error the operator can read; an output that never parsed keeps its unpersisted one. A
 * regression run generates nothing, so it has no end and never lands here.
 */
export async function settleGenerationEnd(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, cfg, workspace, trail, services } = ctx;
  const { generated } = state.generation;
  const { diff: classificationDiff, intent: classificationIntent } = state.classification;
  const { retrievedRuleIds, diffArchetypes, moreNodes: groundingMoreNodes } = state.grounding;
  const agentBrowserSignal = () => trail.agentBrowser?.signals();
  if (generated.end !== null) {
    trail.generationEnd = generated.end;
    const terminal = terminalForGenerationEnd(generated.end);
    if (terminal.action === "continue") {
      if (generated.turn?.exhausted === true) {
        deps.observer?.onEvent({
          type: "log.line",
          level: "warn",
          text: `[qa] the generator ran out of steps (${generated.turn.stepsUsed ?? "?"}/${generated.turn.maxSteps ?? "?"}) but delivered ${generated.specs.length} spec(s); continuing`,
        });
      }
    } else if (terminal.action === "skip") {
      /* Observe-only: an unobservable no-op beside a pack that showed more nodes than unchanged lines is logged, never acted on. */
      if (generated.noopKind === NOOP_KIND.UNOBSERVABLE && groundingMoreNodes.length > 0) {
        deps.observer?.onEvent({
          type: "log.line",
          level: "warn",
          text: `[qa] the generator declared the change unobservable on DEV, while the pack's changed-value lines show more nodes than unchanged lines for ${groundingMoreNodes.length} changed value(s)`,
        });
      }
      const skipped = ctx.ends.skipped({ note: generated.note, reviewerApproved: reviewerApprovalOf(generated) });
      const skipLoopSignal = await closedLoopSignal(ctx);
      return {
        end: await ctx.ends.persistSkipped(skipped, {
          ...(generated.noopKind ? { noop: { kind: generated.noopKind } } : {}),
          ...(services.confinement.totals !== undefined ? { confinement: services.confinement.totals } : {}),
          ...(skipLoopSignal ? { closedLoop: skipLoopSignal } : {}),
          ...(agentBrowserSignal() ? { agentBrowser: agentBrowserSignal() } : {}),
        }),
      };
    } else if (terminal.persisted) {
      const endNote = generated.note ?? `generation ended without specs (${generated.end})`;
      console.error(`[qa] generation ended without specs (${generated.end}): ${endNote}`);
      deps.observer?.onEvent({ type: "agent.error", detail: endNote });
      deps.observer?.onEvent({
        type: "log.line",
        level: "error",
        text: `[qa] generation ended without specs (${terminal.errorClass}): an engine-side ${engineSideCauseOf(generated.end)}, not a fault of the app under test`,
      });
      return {
        end: await ctx.ends.terminal(terminal.verdict, { generating: true, static: false }, {
          generationEnd: generated.end,
          note: endNote,
          reviewerApproved: reviewerApprovalOf(generated),
          rulesRetrieved: retrievedRuleIds,
          diffArchetypes,
          archetype: detectArchetype(classificationDiff, classificationIntent?.changedFiles ?? []),
          confinement: services.confinement.totals,
          mirrorDir: workspace.mirrorDir,
          closedLoop: await closedLoopSignal(ctx),
          agentBrowser: agentBrowserSignal(),
        }),
      };
    } else {
      const emptyNote =
        generated.note ||
        "generation produced no parseable output — the agent runtime returned an empty/errored session " +
          "(provider unavailable, quota exhausted, timeout, or model refusal). Not a code defect and not a " +
          "no-op decision; surfaced as infra-error so it is diagnosable rather than a silent skip.";
      console.error(`[qa] generation runtime failure (empty, unparseable output): ${emptyNote}`);
      return { end: await ctx.ends.infraError(emptyNote, workspace.mirrorDir) };
    }
  }
}

/*
 * Reads the on-disk specs. Only the catalog gate's corrections come back to be repaired (a
 * correction names no spec, but the gate says which spec raised each: the files are those of the
 * capture's specs); an ambiguity is counted and warned about, and asks for nothing.
 * One-shot corrective regen before the static gate. Adopt the regen only if it
 * produced specs — an empty result must not discard the original specs.
 */
export async function groundBeforeExecution(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, workspace, signal } = ctx;
  /* Absent port: counters stay 0, not undefined. Accumulated so they survive every terminal. The ambiguity check is advisory (it is a regex over the spec text, and real execution decides), so nothing is blocked on it and `deterministicSelectorBlocks` stays 0. */
  let preExecAmbiguityCatches = 0;
  let catalogGateInWindow = 0;
  let catalogGateAdvisory = 0;
  let catalogGateFailClosed = 0;
  const runPreExecGrounding = async (): Promise<{ corrections: string[]; attributedSpecFiles: string[] }> => {
    if (!deps.preExecGrounding) return { corrections: [], attributedSpecFiles: [] };
    const { specFiles, specSources, routes } = await deps.preExecGrounding.capture(workspace.specDir, signal);
    const result = checkPreExecGrounding({ specSources, routes });
    preExecAmbiguityCatches += result.preExecAmbiguityCatches;
    if (result.ambiguities.length > 0) {
      const text = `[qa] pre-exec ambiguity check (advisory, execution decides): ${result.ambiguities.join(" | ")}`;
      console.warn(text);
      deps.observer?.onEvent({ type: "log.line", level: "warn", text });
    }
    catalogGateInWindow += result.catalogGateInWindow;
    catalogGateAdvisory += result.catalogGateAdvisory;
    catalogGateFailClosed += result.catalogGateFailClosed;
    ctx.ends.noteGroundingGates(result);
    return { corrections: result.corrections, attributedSpecFiles: attributeContradictions(result.corrections, result.origins, specFiles) };
  };
  let generated = state.generation.generated;
  const { corrections: groundingCorrections, attributedSpecFiles: groundingAttribution } = await runPreExecGrounding();
  /* A spec the generator saw pass against DEV is not rewritten for what a static look at its selectors suspects. */
  const correctiveRegenRetired = groundingCorrections.length > 0 && (await loopClosedNow(ctx));
  if (correctiveRegenRetired) {
    deps.observer?.onEvent({ type: "log.line", level: "info", text: "[qa] pre-exec grounding raised corrections, but every delivered spec was seen passing through run_spec: no corrective regeneration" });
  }
  if (groundingCorrections.length > 0 && !correctiveRegenRetired) {
    deps.observer?.onStep("retry", "pre-exec grounding: corrective regen");
    const corrected = await regenerate(state, ctx, signal, {
      selectorContradictions: groundingCorrections,
      ...(groundingAttribution.length > 0 ? { attributedSpecFiles: groundingAttribution } : {}),
    });
    await ctx.services.confinement.enforce();
    if (corrected.specs.length > 0) {
      generated = corrected;
    }
  }
  return {
    update: {
      generation: { ...state.generation, generated, preExecAmbiguityCatches, catalogGateInWindow, catalogGateAdvisory, catalogGateFailClosed, groundingCorrections, groundingAttribution },
    },
  };
}
