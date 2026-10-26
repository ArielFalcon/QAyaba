/* The ground phase of a run: what the agent is handed before it writes anything. The learned rules are retrieved, the curriculum's exemplars chosen, the repository grounded, and the blast radius, the service links and the cross-repo impact resolved; together they make the enrichment every generation starts from. */

import type { RetrievedRule } from "@kernel/learned-rule.ts";
import type { ServiceLink, ContractDrift, CrossRepoImpact } from "@kernel/service-links.ts";
import { PRE_GENERATION_GROUNDING_STEP_DETAIL } from "@kernel/run-step.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import { detectStructuralPatterns } from "@kernel/structural-pattern.ts";
import type { RelevanceBias } from "@contexts/cross-run-learning/application/index.ts";
import type { StepOutcome } from "../run-flow.ts";
import { throwIfAborted } from "../abort.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import type { RunState } from "../run-state.ts";
import { recordRunFact } from "../reducers.ts";
import { carryOn } from "../failure-policy.ts";

type Result = Promise<StepOutcome<RunState>>;

/*
 * Bias retrieval toward the CURRENT diff's structural shape, using the SAME detector generation's own curriculum/archetype calls already use (detectArchetype
 * below, curriculum.select() above) so the offered archetypes never silently diverge from what
 * biases retrieval. The diff is undefined outside diff mode (only "diff" classifies), so there is no signal to bias with there; never fabricated.
 *
 * Retrieval is NOT biased by the app's most recent persisted errorClass: RunHistoryPort is
 * save-only (no read-back — see run-pipeline.adapter.ts's own header note), and no
 * port wired into this use-case at this point in the flow can answer "what was this app's
 * last outcome's errorClass", so that signal is left unwired rather than invented.
 *
 * The diff's structural shapes, read once: they bias retrieval (specific shapes only) and ride
 * on every folded outcome so the fold credits only the retrieved rules attributable to them.
 * Undefined outside diff mode — no diff, no shape, never fabricated.
 */
export async function readDiffShapes(state: Readonly<RunState>, _ctx: WorkspaceRunContext): Result {
  const { diff: classificationDiff, intent: classificationIntent } = state.classification;
  const diffArchetypes = classificationDiff
    ? detectStructuralPatterns(classificationDiff, classificationIntent?.changedFiles ?? []).map((p) => p.kind)
    : undefined;
  const retrievalArchetypes = (diffArchetypes ?? []).filter((k) => k !== "generic");
  const retrievalRelevance: RelevanceBias | undefined =
    retrievalArchetypes.length > 0 ? { archetypes: retrievalArchetypes } : undefined;
  return { update: { grounding: { ...state.grounding, diffArchetypes, retrievalRelevance } } };
}

/*
 * sha is always present so manifest changeRef.sha is never empty.
 * retrieve() is enrichment, not a requirement: failure is caught and generation
 * continues. Prompt renderers use trigger/action; retrievedRuleIds (r.id) are
 * for by-id fold attribution — never conflate the two.
 */
export async function retrieveRules(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input } = ctx;
  let retrievedRules: RetrievedRule[] = [];
  try {
    retrievedRules = await deps.learning.retrieve(input.sha, state.grounding.retrievalRelevance);
  } catch (err) {
    console.error("[qa] learning retrieval failed (non-fatal, generation continues ungrounded):", err);
  }
  const retrievedRuleIds = retrievedRules.map((r) => r.id);
  recordRunFact(state, "rulesRetrieved", retrievedRuleIds);
  return { update: { grounding: { ...state.grounding, retrievedRules, retrievedRuleIds } } };
}

/*
 * Settled before any prompt is built. The fold must credit exactly the
 * archetypes this prompt carried. A regression run never calls generate(), so
 * the set stays empty — including any later coverage regen on that run.
 */
export async function selectExemplars(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps } = ctx;
  const { diff: classificationDiff, intent: classificationIntent, generating } = state.classification;
  const selectedExemplars = generating && deps.curriculum
    ? await deps.curriculum.select(classificationDiff, classificationIntent?.changedFiles ?? [])
    : [];
  const offeredArchetypes = selectedExemplars.map((e) => e.archetype);
  return { update: { grounding: { ...state.grounding, selectedExemplars, offeredArchetypes } } };
}

/*
 * Once after setup, before the first generate(); reused unchanged on regen.
 * Fail-open: a misbehaving adapter must never abort the run over grounding.
 */
export async function groundRepository(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, workspace, signal, input } = ctx;
  const { diff: classificationDiff } = state.classification;
  let groundingContextPack: string | undefined;
  let groundingContextPackItemIds: readonly string[] | undefined;
  let groundingContextPackOmissions: RunState["grounding"]["contextPackOmissions"];
  let groundingExistingSpecFiles: string[] | undefined;
  let groundingContextMap: RunState["grounding"]["contextMap"];
  let groundingHarnessFacts: RunState["grounding"]["harnessFacts"];
  /* The added labels whose changed-value line in the pack said more nodes than unchanged lines: what an unobservable no-op is set beside. */
  let groundingMoreNodes: readonly string[] = [];
  let groundingChangeRoutes: readonly string[] = [];
  let groundingChangeProofs: RunState["grounding"]["changeProofs"] = [];
  let groundingConfirmedDataRoutes: RunState["grounding"]["confirmedDataRoutes"];
  if (deps.preGenerationGrounding) {
    deps.observer?.onStep("generate", PRE_GENERATION_GROUNDING_STEP_DETAIL);
    try {
      const grounding = await deps.preGenerationGrounding.ground(workspace.specDir, signal, classificationDiff, {
        sha: input.sha.toString(),
        serviceLinks: state.grounding.serviceLinks,
        crossRepoImpact: state.grounding.crossRepoImpact,
      });
      groundingContextPack = grounding.contextPack;
      groundingContextPackItemIds = grounding.contextPackItemIds;
      groundingContextPackOmissions = grounding.contextPackOmissions;
      groundingExistingSpecFiles = grounding.existingSpecFiles;
      groundingContextMap = grounding.contextMap;
      groundingHarnessFacts = grounding.harnessFacts;
      groundingMoreNodes = grounding.changedValuesWithMoreNodes ?? [];
      groundingChangeRoutes = grounding.changeRoutes ?? [];
      groundingChangeProofs = grounding.changePages?.pages ?? [];
      groundingConfirmedDataRoutes = grounding.packConfirmedDataRoutes;
    } catch (err) {
      carryOn(err);
      /* Abort during grounding takes the abort route, not ungrounded continue. */
      throwIfAborted(signal);
      console.error("[qa] WARNING: pre-generation grounding failed (non-fatal, generation continues ungrounded):", err);
    }
  }
  return {
    update: {
      grounding: {
        ...state.grounding,
        contextPack: groundingContextPack,
        contextPackItemIds: groundingContextPackItemIds,
        contextPackOmissions: groundingContextPackOmissions,
        existingSpecFiles: groundingExistingSpecFiles,
        contextMap: groundingContextMap,
        harnessFacts: groundingHarnessFacts,
        moreNodes: groundingMoreNodes,
        changeRoutes: groundingChangeRoutes,
        changeProofs: groundingChangeProofs,
        confirmedDataRoutes: groundingConfirmedDataRoutes,
      },
    },
  };
}

/*
 * Built from the classified intent's changed files. Empty outside diff mode.
 * The same BlastRadius is reused for measure() so the code-target oracle is
 * scoped to the diff; the e2e oracle ignores it.
 * The structural signal is advisory only; a throw degrades to "" and never aborts.
 * It is queried against the classify-source repo so a cross-repo BlastRadius hits
 * the matching graph.
 */
export async function resolveBlastRadius(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, workspace } = ctx;
  const { intent: classificationIntent, diff } = state.classification;
  /* The diff's touched lines seed the graph walk at the changed symbols rather than at every symbol of a changed file. */
  const runBlastRadius = BlastRadius.of(input.sha, classificationIntent?.changedFiles ?? [], diff ? new DiffParserService().touchedLines(diff) : undefined);
  let blastRadiusSignal = "";
  let blastRadiusSignalHasSymbols = false;
  let blastRadiusSignalFiles: readonly string[] = [];
  if (deps.structuralSignal) {
    try {
      const rendered = await deps.structuralSignal.render(workspace.specDir, runBlastRadius);
      blastRadiusSignal = rendered.text;
      blastRadiusSignalHasSymbols = rendered.hasSymbols;
      blastRadiusSignalFiles = rendered.providedFiles ?? [];
    } catch (err) {
      console.error("[qa] WARNING: structural blast-radius signal failed (non-fatal, generation continues without it):", err);
    }
  }
  return { update: { grounding: { ...state.grounding, blastRadiusSignal, blastRadiusSignalHasSymbols, blastRadiusSignalFiles } } };
}

/* Not gated on diff mode. Advisory; throw degrades to empty links/drift. */
export async function resolveServiceLinks(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps } = ctx;
  let resolvedServiceLinks: readonly ServiceLink[] = [];
  let resolvedContractDrift: readonly ContractDrift[] = [];
  if (deps.serviceLinks) {
    try {
      const r = await deps.serviceLinks.resolve();
      resolvedServiceLinks = r.links;
      resolvedContractDrift = r.drift;
    } catch (err) {
      console.error("[qa] WARNING: service-links resolution failed (non-fatal, generation continues without it):", err);
    }
  }
  return { update: { grounding: { ...state.grounding, serviceLinks: resolvedServiceLinks, contractDrift: resolvedContractDrift } } };
}

/*
 * Only on cross-repo runs. The .some() pre-filter skips the await when no
 * resolved link targets triggerRepo. A throw is fail-open, except an untrusted git dir (the mirror was replaced by
 * untrusted code), which fails the run.
 */
export async function resolveCrossRepoImpact(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input } = ctx;
  const resolvedServiceLinks = state.grounding.serviceLinks;
  let crossRepoImpact: CrossRepoImpact | null = null;
  if (
    deps.crossRepoImpact &&
    input.triggerRepo &&
    resolvedServiceLinks.length &&
    resolvedServiceLinks.some((l) => l.to.repo === input.triggerRepo)
  ) {
    try {
      crossRepoImpact = await deps.crossRepoImpact.resolve(input.triggerRepo, input.sha.toString(), resolvedServiceLinks);
    } catch (err) {
      carryOn(err);
      console.error("[qa] WARNING: cross-repo impact resolution failed (non-fatal, generation continues without it):", err);
    }
  }
  return { update: { grounding: { ...state.grounding, crossRepoImpact } } };
}

/* The enrichment every generation of the run starts from, assembled from everything the phase gathered. */
export async function assembleEnrichment(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { input, trail } = ctx;
  const { intent: classificationIntent, reason: classificationReason, contradiction: classificationContradiction } = state.classification;
  const { closedLoop, agentBrowser } = trail;
  const { retrievedRules, contextPack, contextPackItemIds, contextPackOmissions, existingSpecFiles, contextMap, harnessFacts, blastRadiusSignal, blastRadiusSignalHasSymbols, blastRadiusSignalFiles, selectedExemplars, serviceLinks, contractDrift, crossRepoImpact } = state.grounding;
  const baseEnrichment = {
    sha: input.sha.toString(),
    runId: input.runId,
    ...(classificationIntent ? { intent: classificationIntent } : {}),
    ...(retrievedRules.length ? { learnedRules: retrievedRules } : {}),
    ...(contextPack ? { contextPack } : {}),
    ...(contextPackItemIds ? { contextPackItemIds } : {}),
    ...(contextPackOmissions ? { contextPackOmissions } : {}),
    ...(existingSpecFiles?.length ? { existingSpecFiles } : {}),
    ...(contextMap ? { contextMap } : {}),
    ...(harnessFacts ? { harnessFacts } : {}),
    /* The flag travels with its signal and only when true: a co-change-only signal carries none, never a fabricated false. */
    ...(blastRadiusSignal
      ? { staticSignal: blastRadiusSignal, ...(blastRadiusSignalHasSymbols ? { staticSignalHasSymbols: true } : {}), ...(blastRadiusSignalFiles.length ? { staticSignalFiles: blastRadiusSignalFiles } : {}) }
      : {}),
    ...(selectedExemplars.length ? { skillExemplars: selectedExemplars } : {}),
    ...(closedLoop ? { closedLoop: closedLoop.limits } : {}),
    ...(agentBrowser ? { agentBrowser: agentBrowser.limits } : {}),
    ...(serviceLinks.length ? { serviceLinks } : {}),
    ...(contractDrift.length ? { contractDrift } : {}),
    ...(crossRepoImpact?.impactedLinks.length ? { crossRepoImpact: { impactedLinks: crossRepoImpact.impactedLinks } } : {}),
    /* contradiction is spread only when true — never fabricated as false. */
    ...(classificationReason ? { classificationReason } : {}),
    ...(classificationContradiction ? { contradiction: true } : {}),
  };
  return { update: { grounding: { ...state.grounding, baseEnrichment } } };
}
