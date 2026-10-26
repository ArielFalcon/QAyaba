/* The generate phase of a run: the agent writes the specs (or the lead/sidekick mode authors them as flows), the way the generation ended decides whether the run goes on, and the pre-exec grounding may ask for one corrective regeneration before the static gate. */

import { CORRECTION_ORIGIN } from "@contexts/coordination/application/index.ts";
import { relative } from "node:path";
import { DEFAULT_COORDINATION_SETTINGS } from "@kernel/coordination.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import { NOOP_KIND } from "@kernel/noop-kind.ts";
import { attributeContradictions } from "../../../domain/helpers/contradiction-attribution.ts";
import { engineSideCauseOf, terminalForGenerationEnd } from "../../../domain/helpers/generation-end-terminal.ts";
import { checkPreExecGrounding } from "@contexts/generation/application/index.ts";
import { detectArchetype } from "@contexts/cross-run-learning/application/index.ts";
import { reviewerApprovalOf } from "@contexts/generation/application/index.ts";
import type { GenerationOutput } from "@contexts/generation/application/index.ts";
import type { CoordinateResult } from "@contexts/coordination/application/index.ts";
import { end, type StepOutcome } from "../run-flow.ts";
import { throwIfAborted } from "../abort.ts";
import { preExecAction } from "../../../domain/pre-exec-regen.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import type { RunState } from "../run-state.ts";
import { mergeDelivered, recordRunFact } from "../reducers.ts";
import { afterGeneration, closedLoopSignal, geolocationEnrichment, loopClosedNow, regenerate } from "./generation-services.ts";
import { carryOn } from "../failure-policy.ts";

type Result = Promise<StepOutcome<RunState>>;

/*
 * Lead + sidekicks is how every e2e run generates: the lead is asked for a plan and its flows are authored by sidekicks, each in a
 * workspace of its own. What comes back is a generation like any other: the specs of the flows that delivered, a declared no-op, or
 * an end that names why nothing was finished. No generation: the lead authors the change in one turn, because no coordinator is wired,
 * the plan was not admitted as a fan-out, no sidekick can author, or coordination failed (the recorded signal says which).
 * A code run, a context run and a login still to be written never coordinate. `unvisitedChangePages`: the change pages an admitted plan
 * left to the lead did not visit, which the lead's own turn is told.
 */
async function coordinateFirstPass(state: Readonly<RunState>, ctx: WorkspaceRunContext): Promise<{ generated?: GenerationOutput; unvisitedChangePages?: readonly string[]; leadReviewTurns?: number }> {
  const { deps, input, cfg, workspace, signal } = ctx;
  const { closedLoop, agentBrowser, geolocation } = ctx.trail;
  const { generating, intent: classificationIntent, diff: classificationDiff } = state.classification;
  const { authSeedUnauthored } = state.setup;
  const { baseEnrichment } = state.grounding;
  const coordinationSettings = deps.coordinationSettings ?? DEFAULT_COORDINATION_SETTINGS;
  if (!deps.leadSidekicks) return {};
  if (!generating || cfg.isCode || input.mode === "context" || authSeedUnauthored) return {};
  let result: CoordinateResult;
  try {
    result = await deps.leadSidekicks.coordinate({
      runId: input.runId,
      app: input.app,
      objective: input.guidance ?? classificationIntent?.message ?? `QA run ${input.runId}`,
      mirrorDir: ctx.services.specRoot.mirrorDir,
      specDir: workspace.specDir,
      specRelDir: relative(ctx.services.specRoot.mirrorDir, workspace.specDir).replace(/\\/g, "/") || "e2e",
      settings: coordinationSettings,
      facts: { hasLogin: Boolean(deps.authContext?.auth), provider: deps.sidekickProvider?.(), plannerProvider: deps.plannerProvider?.() },
      ...(closedLoop ? { closedLoop } : {}),
      ...(agentBrowser ? { agentBrowser } : {}),
      ...(geolocation ? { geolocation } : {}),
      ...(deps.sidekickDevBaseUrl ? { devBaseUrl: deps.sidekickDevBaseUrl } : {}),
      ...(state.grounding.confirmedDataRoutes?.length ? { confirmedDataRoutes: state.grounding.confirmedDataRoutes } : {}),
      ...(state.grounding.contextPack ? { contextPack: state.grounding.contextPack } : {}),
      ...(state.grounding.changeRoutes.length > 0 ? { changeRoutes: state.grounding.changeRoutes } : {}),
      ...(state.grounding.changeProofs.length > 0 ? { changeProofs: state.grounding.changeProofs } : {}),
      ...(deps.generation.plan
        ? { plan: (planning) => deps.generation.plan!(workspace.specDir, signal, classificationDiff, { ...baseEnrichment, ...geolocationEnrichment(ctx), planning }) }
        : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    carryOn(err);
    console.error(`[qa] coordination failed (the lead authors the change alone): ${err instanceof Error ? err.message : String(err)}`);
    ctx.host.recordCoordination({ downgrade: "coordination failed", flows: 0, delivered: 0, incomplete: 0, takeover: false });
    return {};
  }
  ctx.host.recordCoordination(result.signal);
  /* The turns the lead spent reviewing the flows, counted from the signal the coordination records. */
  const leadReviewTurns = result.signal.review?.turns ?? 0;
  if (result.action === "lead") return { ...(result.unvisited ? { unvisitedChangePages: result.unvisited } : {}), leadReviewTurns };
  if (result.action === "noop") {
    /* A plan names no kind of no-op. */
    return { leadReviewTurns, generated: { specs: [], end: GENERATION_END.DECLARED_NOOP, noopKind: NOOP_KIND.UNSPECIFIED, reviewed: false, approved: true, parsed: true, note: result.reason } };
  }
  const { aggregated } = result;
  /* Kept open for the reviewer's corrections only when the flows delivered: nothing else reaches a review. */
  if (result.pass) {
    if (aggregated.end === GENERATION_END.DELIVERED) ctx.trail.coordinatedPass = result.pass;
    else await result.pass.release().catch((err: unknown) => console.error(`[qa] releasing the coordinated pass failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  if (aggregated.end !== GENERATION_END.DELIVERED) {
    return { leadReviewTurns, generated: { specs: [], end: aggregated.end, reviewed: false, approved: true, parsed: true, ...(aggregated.note ? { note: aggregated.note } : {}) } };
  }
  const unfinished = aggregated.incompleteFlows.map((f) => `${f.id} (${f.kind})`).join(", ");
  if (unfinished) deps.observer?.onEvent({ type: "log.line", level: "warn", text: `coordination: ${aggregated.incompleteFlows.length} flow(s) did not finish: ${unfinished}` });
  return { leadReviewTurns, generated: await afterGeneration(ctx, { specs: aggregated.specs, end: GENERATION_END.DELIVERED, reviewed: false, approved: true, parsed: true, ...(unfinished ? { note: `flows that did not finish: ${unfinished}` } : {}) }) };
}

/*
 * Skipped when generating is false (regression) — the synthetic empty approved
 * result is not a GenerationPort call.
 * In the lead/sidekick mode the flows' specs stand in for the lead's first pass (coordinateFirstPass).
 */
export async function generateFirstPass(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, workspace, signal } = ctx;
  const { generating, diff: classificationDiff } = state.classification;
  const { authSeedUnauthored } = state.setup;
  const { baseEnrichment } = state.grounding;
  /* mutation-scope:begin regression-run-stand-in */
  deps.observer?.onStep("generate", generating ? undefined : "regression: running the existing suite, not generating");
  /* A regression run generates nothing: a stand-in with no generation end, never one a generation could return. */
  let generated = state.generation.generated;
  let leadReviewTurns = 0;
  if (!generating) {
    generated = { specs: [], approved: true, reviewed: false, end: null };
  } else {
  /* mutation-scope:end regression-run-stand-in */
    /*
     * A stock seed that did not sign in reaches the generator as its own fact in every mode (the
     * prompt builders render the rewrite instruction); the Context Pack stays grounding-only.
     * The coordination does not engage for such a run (coordinateFirstPass): sidekick output from the login wall is
     * not the session the suite will run with.
     */
    const coordinated = await coordinateFirstPass(state, ctx);
    const coordinatedFirstPass = coordinated.generated;
    leadReviewTurns = coordinated.leadReviewTurns ?? 0;
    throwIfAborted(signal);
    generated = coordinatedFirstPass
      ?? (await afterGeneration(ctx, await deps.generation.generate(workspace.specDir, signal, classificationDiff, {
        ...baseEnrichment,
        ...geolocationEnrichment(ctx),
        ...(authSeedUnauthored ? { authSeedUnauthored: true } : {}),
        ...(coordinated.unvisitedChangePages ? { unvisitedChangePages: coordinated.unvisitedChangePages } : {}),
      })));
    mergeDelivered(state, generated, coordinatedFirstPass ? "sidekick" : "lead");
  }
  /*
   * Confinement after a real generate() only. The regression synthetic stand-in
   * wrote nothing. Sidekick writes are still agent writes.
   */
  if (generating) await ctx.services.confinement.enforce();
  return { update: { generation: { ...state.generation, generated }, loops: { ...state.loops, leadReviewTurns } } };
}

/*
 * How the generation ended decides how the run does. With specs the run continues (a generation
 * that also ran out of steps is only logged). Without specs only a declared no-op is a decision
 * and skips; running out of steps, or a verdict that decides nothing, ends the run as a persisted
 * infra-error the operator can read; an output that never parsed keeps its unpersisted one. A
 * regression run generates nothing, so it has no end and never lands here.
 */
export async function settleGenerationEnd(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, trail, services } = ctx;
  const { generated } = state.generation;
  const { diff: classificationDiff, intent: classificationIntent } = state.classification;
  const { retrievedRuleIds, diffArchetypes, moreNodes: groundingMoreNodes } = state.grounding;
  const agentBrowserSignal = () => trail.agentBrowser?.signals();
  if (generated.end !== null) {
    recordRunFact(state, "generationEnd", generated.end);
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
      const skipLoopSignal = await closedLoopSignal(state, ctx);
      return end("generation-noop", {
        note: generated.note,
        reviewerApproved: reviewerApprovalOf(generated),
        ...(generated.noopKind ? { noop: { kind: generated.noopKind } } : {}),
        ...(services.confinement.totals !== undefined ? { confinement: services.confinement.totals } : {}),
        ...(skipLoopSignal ? { closedLoop: skipLoopSignal } : {}),
        ...(agentBrowserSignal() ? { agentBrowser: agentBrowserSignal() } : {}),
      });
    } else if (terminal.persisted) {
      const endNote = generated.note ?? `generation ended without specs (${generated.end})`;
      console.error(`[qa] generation ended without specs (${generated.end}): ${endNote}`);
      deps.observer?.onEvent({ type: "agent.error", detail: endNote });
      deps.observer?.onEvent({
        type: "log.line",
        level: "error",
        text: `[qa] generation ended without specs (${terminal.errorClass}): an engine-side ${engineSideCauseOf(generated.end)}, not a fault of the app under test`,
      });
      return end("generation-ended-without-specs", {
        generationEnd: generated.end,
        note: endNote,
        reviewerApproved: reviewerApprovalOf(generated),
        rulesRetrieved: retrievedRuleIds,
        diffArchetypes,
        archetype: detectArchetype(classificationDiff, classificationIntent?.changedFiles ?? []),
        confinement: services.confinement.totals,
        closedLoop: await closedLoopSignal(state, ctx),
        agentBrowser: agentBrowserSignal(),
      });
    } else {
      const emptyNote =
        generated.note ||
        "generation produced no parseable output — the agent runtime returned an empty/errored session " +
          "(provider unavailable, quota exhausted, timeout, or model refusal). Not a code defect and not a " +
          "no-op decision; surfaced as infra-error so it is diagnosable rather than a silent skip.";
      console.error(`[qa] generation runtime failure (empty, unparseable output): ${emptyNote}`);
      return end("generation-empty-output", { note: emptyNote });
    }
  }
}

/*
 * Reads the on-disk specs. Only the catalog gate's corrections come back to be repaired (a
 * correction names no spec, but the gate says which spec raised each: the files are those of the
 * capture's specs); an ambiguity is counted and warned about, and asks for nothing.
 * The corrective regeneration they may earn is the next step (preExecRegenerate).
 */
export async function groundBeforeExecution(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, workspace, signal } = ctx;
  /* Absent port: counters stay 0, not undefined. Accumulated so they survive every terminal. The ambiguity check is advisory (it is a regex over the spec text, and real execution decides), so nothing is blocked on it and `deterministicSelectorBlocks` stays 0. */
  let preExecAmbiguityCatches = 0;
  let catalogGateInWindow = 0;
  let catalogGateAdvisory = 0;
  /* mutation-scope:begin fail-closed-counter */
  let catalogGateFailClosed = 0;
  /* mutation-scope:end fail-closed-counter */
  const runPreExecGrounding = async (): Promise<{ corrections: string[]; attributedSpecFiles: string[] }> => {
    if (!deps.preExecGrounding) return { corrections: [], attributedSpecFiles: [] };
    /* mutation-scope:begin pre-exec-capture-and-check */
    const { specFiles, specSources, routes } = await deps.preExecGrounding.capture(workspace.specDir, signal);
    /* mutation-scope:end pre-exec-capture-and-check */
    const result = checkPreExecGrounding({ specSources, routes });
    preExecAmbiguityCatches += result.preExecAmbiguityCatches;
    if (result.ambiguities.length > 0) {
      const text = `[qa] pre-exec ambiguity check (advisory, execution decides): ${result.ambiguities.join(" | ")}`;
      console.warn(text);
      deps.observer?.onEvent({ type: "log.line", level: "warn", text });
    }
    /* mutation-scope:begin catalog-gate-counters */
    catalogGateInWindow += result.catalogGateInWindow;
    catalogGateAdvisory += result.catalogGateAdvisory;
    catalogGateFailClosed += result.catalogGateFailClosed;
    ctx.host.noteGroundingGates(result);
    /* mutation-scope:end catalog-gate-counters */
    return { corrections: result.corrections, attributedSpecFiles: attributeContradictions(result.corrections, result.origins, specFiles) };
  };
  const { corrections: groundingCorrections, attributedSpecFiles: groundingAttribution } = await runPreExecGrounding();
  return {
    update: {
      generation: { ...state.generation, preExecAmbiguityCatches, catalogGateInWindow, catalogGateAdvisory, catalogGateFailClosed, groundingCorrections, groundingAttribution },
    },
  };
}

/*
 * One-shot corrective regen before the static gate, when the grounding raised corrections that nothing has repaired and the specs
 * are not ones the generator saw pass. Adopt the regen only if it produced specs: an empty result must not discard the original specs.
 */
export async function preExecRegenerate(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, signal } = ctx;
  const { groundingCorrections, groundingAttribution } = state.generation;
  /* A spec the generator saw pass against DEV is not rewritten for what a static look at its selectors suspects. */
  const retired = groundingCorrections.length > 0 && (await loopClosedNow(state, ctx));
  if (retired) {
    deps.observer?.onEvent({ type: "log.line", level: "info", text: "[qa] pre-exec grounding raised corrections, but every delivered spec was seen passing through run_spec: no corrective regeneration" });
  }
  if (preExecAction({ corrections: groundingCorrections.length, retired, regenerated: state.loops.preExecRegen }) === "proceed") return;
  deps.observer?.onStep("retry", "pre-exec grounding: corrective regen");
  const { output: corrected, leadCorrections } = await regenerate(state, ctx, signal, {
    selectorContradictions: groundingCorrections,
    ...(groundingAttribution.length > 0 ? { attributedSpecFiles: groundingAttribution } : {}),
  }, CORRECTION_ORIGIN.PRE_EXEC);
  await ctx.services.confinement.enforce();
  return {
    update: {
      generation: { ...state.generation, generated: corrected.specs.length > 0 ? corrected : state.generation.generated },
      loops: { ...state.loops, preExecRegen: state.loops.preExecRegen + 1, leadCorrections: state.loops.leadCorrections + leadCorrections },
    },
  };
}
