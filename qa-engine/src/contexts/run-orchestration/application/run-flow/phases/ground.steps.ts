/* The ground phase of a run: what the agent is handed before it writes anything. The learned rules are retrieved, the curriculum's exemplars chosen, the repository grounded, and the blast radius, the service links and the cross-repo impact resolved; together they make the enrichment every generation starts from. */

import { engineLog } from "@kernel/ports/process-logger.ts";
import type { RetrievedRule } from "@kernel/learned-rule.ts";
import type { ServiceLink, ContractDrift, CrossRepoImpact } from "@kernel/service-links.ts";
import { PRE_GENERATION_GROUNDING_STEP_DETAIL } from "@kernel/run-step.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import { detectStructuralPatterns } from "@kernel/structural-pattern.ts";
import type { DecisionListing } from "@kernel/changed-decision.ts";
import type { RelevanceBias } from "@contexts/cross-run-learning/application/index.ts";
import type { ChangeScope, ChangeScopeRepo, ReachTier, UseCaseCandidate } from "@contexts/change-analysis/application/index.ts";
import type { StepOutcome } from "../run-flow.ts";
import { throwIfAborted } from "../abort.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import type { RunState } from "../run-state.ts";
import { recordRunFact } from "../reducers.ts";
import { carryOn } from "../failure-policy.ts";
import { availabilityGroundingOf } from "../route-availability-grounding.ts";

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
    engineLog.error("[qa] learning retrieval failed (non-fatal, generation continues ungrounded):", { error: err });
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
  let groundingConfirmedDataRoutes: RunState["grounding"]["confirmedDataRoutes"];
  let groundingChangedDecisions: RunState["grounding"]["changedDecisions"] = [];
  let groundingRouteAvailability: RunState["grounding"]["routeAvailability"];
  if (deps.preGenerationGrounding) {
    deps.observer?.onStep("generate", PRE_GENERATION_GROUNDING_STEP_DETAIL);
    try {
      const grounding = await deps.preGenerationGrounding.ground(workspace.specDir, signal, classificationDiff, {
        sha: input.sha.toString(),
        serviceLinks: state.grounding.serviceLinks,
        crossRepoImpact: state.grounding.crossRepoImpact,
        candidates: state.grounding.candidates,
        hubPages: hubPagesOf(state.grounding.changeScope),
        ...availabilityGroundingOf(state, ctx),
      });
      groundingRouteAvailability = grounding.routeAvailability;
      groundingContextPack = grounding.contextPack;
      groundingContextPackItemIds = grounding.contextPackItemIds;
      groundingContextPackOmissions = grounding.contextPackOmissions;
      groundingExistingSpecFiles = grounding.existingSpecFiles;
      groundingContextMap = grounding.contextMap;
      groundingHarnessFacts = grounding.harnessFacts;
      groundingMoreNodes = grounding.changedValuesWithMoreNodes ?? [];
      groundingConfirmedDataRoutes = grounding.packConfirmedDataRoutes;
      if (grounding.changedDecisions) {
        groundingChangedDecisions = grounding.changedDecisions.decisions;
        recordDecisions(ctx, grounding.changedDecisions);
      }
    } catch (err) {
      carryOn(err);
      /* Abort during grounding takes the abort route, not ungrounded continue. */
      throwIfAborted(signal);
      engineLog.error("[qa] WARNING: pre-generation grounding failed (non-fatal, generation continues ungrounded):", { error: err });
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
        confirmedDataRoutes: groundingConfirmedDataRoutes,
        changedDecisions: groundingChangedDecisions,
        routeAvailability: groundingRouteAvailability,
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
      engineLog.error("[qa] WARNING: structural blast-radius signal failed (non-fatal, generation continues without it):", { error: err });
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
      engineLog.error("[qa] WARNING: service-links resolution failed (non-fatal, generation continues without it):", { error: err });
    }
  }
  return { update: { grounding: { ...state.grounding, serviceLinks: resolvedServiceLinks, contractDrift: resolvedContractDrift } } };
}

/*
 * Only on cross-repo runs: once for the service the run was triggered by and once for each other service entry of its change,
 * each at its own head, and the answers are merged. The .some() pre-filter skips the await when no resolved link targets the
 * repo. A throw is fail-open, except an untrusted git dir (the mirror was replaced by untrusted code), which fails the run.
 */
export async function resolveCrossRepoImpact(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input } = ctx;
  const resolvedServiceLinks = state.grounding.serviceLinks;
  const services: Array<{ repo: string; sha: string; baseRef?: string }> = [];
  /* Where an entry's range starts: its base, or `commits` back from its head; absent, the commit before the head. */
  const baseRefOf = (entry: { headSha: { toString(): string }; baseSha?: { toString(): string }; commits?: number }): string | undefined =>
    entry.baseSha?.toString() ?? (entry.commits !== undefined ? `${entry.headSha.toString()}~${entry.commits}` : undefined);
  const anchor = input.changeSet.anchor;
  if (input.triggerRepo) services.push({ repo: input.triggerRepo, sha: input.sha.toString(), ...(baseRefOf(anchor) ? { baseRef: baseRefOf(anchor)! } : {}) });
  for (const entry of input.changeSet.entries) {
    if (entry.role === "service" && entry !== anchor && entry.repo !== input.triggerRepo) services.push({ repo: entry.repo, sha: entry.headSha.toString(), ...(baseRefOf(entry) ? { baseRef: baseRefOf(entry)! } : {}) });
  }
  const impacts: CrossRepoImpact[] = [];
  if (deps.crossRepoImpact && resolvedServiceLinks.length) {
    for (const { repo, sha, baseRef } of services) {
      if (!resolvedServiceLinks.some((l) => l.to.repo === repo)) continue;
      try {
        const impact = await deps.crossRepoImpact.resolve(repo, sha, resolvedServiceLinks, ...(baseRef ? [baseRef] : []));
        if (impact) impacts.push(impact);
      } catch (err) {
        carryOn(err);
        engineLog.error("[qa] WARNING: cross-repo impact resolution failed (non-fatal, generation continues without it):", { error: err });
      }
    }
  }
  const crossRepoImpact = impacts.length <= 1 ? (impacts[0] ?? null) : mergeImpacts(impacts);
  return { update: { grounding: { ...state.grounding, crossRepoImpact } } };
}

function mergeImpacts(impacts: readonly CrossRepoImpact[]): CrossRepoImpact {
  const serviceImpacted = impacts.flatMap((i) => i.serviceImpacted ?? []);
  return {
    impactedLinks: impacts.flatMap((i) => i.impactedLinks),
    ...(serviceImpacted.length > 0 ? { serviceImpacted } : {}),
  };
}

/*
 * The reach of the change over every repo of the run: the entry points its changed symbols reach, by tier, each with its
 * evidence. Asked of the index the run built; a repo whose index does not answer is a `degraded` entry of the scope and the
 * step never ends a run (only an abort propagates).
 */
export async function computeChangeScope(state: Readonly<RunState>, ctx: WorkspaceRunContext): Result {
  const { deps, input, workspace } = ctx;
  if (!deps.changeScope || input.mode !== "diff") return;
  const { diff, intent, companions } = state.classification;
  const parser = new DiffParserService();
  const sourceDir = deps.codeGraphRepoDir ?? ctx.services.specRoot.mirrorDir;
  const repos: ChangeScopeRepo[] = [];
  const skipped: Array<{ repo: string; reason: string }> = [];
  for (const entry of input.changeSet.entries) {
    const isAnchor = entry === input.changeSet.anchor;
    const repoDir = isAnchor ? sourceDir : deps.codeGraphRepoDirs?.get(entry.repo);
    const read = isAnchor ? { diff, intent } : companions?.find((c) => c.repo === entry.repo);
    if (!repoDir) {
      skipped.push({ repo: entry.repo, reason: "the repo has no index in this run" });
      continue;
    }
    repos.push({
      repo: entry.repo,
      role: entry.role,
      repoDir,
      headSha: entry.headSha.toString(),
      changedFiles: read?.intent?.changedFiles ?? [],
      ...(read?.diff ? { touchedLines: parser.touchedLines(read.diff) } : {}),
    });
  }
  let scope: ChangeScope;
  try {
    scope = await deps.changeScope.resolve({
      specDir: workspace.specDir,
      repos,
      ...(deps.codeGraphPrimary ? { pages: { repo: deps.codeGraphPrimary.repo, repoDir: deps.codeGraphPrimary.repoDir } } : {}),
      crossRepoImpact: state.grounding.crossRepoImpact,
    });
  } catch (err) {
    carryOn(err);
    engineLog.error("[qa] WARNING: the change scope could not be computed (non-fatal, the run goes on without it):", { error: err });
    scope = { repos: [], reach: [], hubs: [], disagreements: [], omitted: 0, degraded: [{ repo: input.changeSet.anchor.repo, reason: err instanceof Error ? err.message : String(err) }] };
  }
  const withSkipped: ChangeScope = skipped.length > 0 ? { ...scope, degraded: [...scope.degraded, ...skipped] } : scope;
  recordScope(ctx, withSkipped);
  let candidates: UseCaseCandidate[] = [];
  try {
    candidates = await deps.changeScope.candidates({ specDir: workspace.specDir, scope: withSkipped });
  } catch (err) {
    carryOn(err);
    engineLog.error("[qa] WARNING: the use-case candidates could not be derived (non-fatal, the run goes on without them):", { error: err });
  }
  recordCandidates(ctx, candidates);
  return { update: { grounding: { ...state.grounding, changeScope: withSkipped, candidates } } };
}

function recordScope(ctx: WorkspaceRunContext, scope: ChangeScope): void {
  const count = (tier: ReachTier): number => scope.reach.filter((r) => r.tier === tier).length;
  try {
    ctx.telemetry.startSpan("qayaba.change_scope", {
      attrs: {
        "qayaba.app": ctx.input.app,
        "qayaba.change_scope.direct": count("direct"),
        "qayaba.change_scope.indirect": count("indirect"),
        "qayaba.change_scope.cross_repo": count("cross-repo"),
        "qayaba.change_scope.omitted": scope.omitted,
        "qayaba.change_scope.hubs": scope.hubs.length,
        "qayaba.change_scope.degraded": scope.degraded.map((d) => `${d.repo}: ${d.reason}`),
        "qayaba.change_scope.seed_basis": scope.repos.map((r) => `${r.repo}: ${r.seedBasis}`),
        "qayaba.change_scope.hub_symbols": scope.hubs.map((h) => `${h.symbol}: ${h.entries}`),
        "qayaba.change_scope.disagreements": scope.disagreements.map((d) => `${d.route}: ${d.engineFile}`),
      },
    }).end();
  } catch (err) {
    engineLog.error(`[telemetry] the change-scope span could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* The pages the hubs of the change reach: too many for any to be a candidate, so they only order the capture. */
function hubPagesOf(scope: ChangeScope | undefined): string[] {
  const PAGE = "page ";
  return [...new Set((scope?.hubs ?? []).flatMap((hub) => hub.keys.filter((key) => key.startsWith(PAGE)).map((key) => key.slice(PAGE.length))))].sort();
}

/* What the static decision listing found: how many decisions, and which changed files of a language with a lister did not parse (they list nothing). */
function recordDecisions(ctx: WorkspaceRunContext, listing: DecisionListing): void {
  try {
    ctx.telemetry.startSpan("qayaba.change.decisions", {
      attrs: {
        "qayaba.app": ctx.input.app,
        "qayaba.decisions.count": listing.decisions.length,
        "qayaba.decisions.unparsed": listing.unparsed,
      },
    }).end();
  } catch (err) {
    engineLog.error(`[telemetry] the decisions span could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function recordCandidates(ctx: WorkspaceRunContext, candidates: readonly UseCaseCandidate[]): void {
  try {
    ctx.telemetry.startSpan("qayaba.change.candidates", {
      attrs: {
        "qayaba.app": ctx.input.app,
        "qayaba.candidates.count": candidates.length,
        "qayaba.candidates.entries": candidates.map((c) => `${c.id}: ${c.entry.kind === "page" ? `page ${c.entry.route}` : `${c.entry.verb} ${c.entry.path}`} [${c.tier}, ${c.reachability}, ${c.basis}]`),
        "qayaba.candidates.proofs": candidates.map((c) => `${c.id}: ${c.evidence.join(" > ")}`),
        "qayaba.candidates.with_specs": candidates.filter((c) => c.existingSpecs.length > 0).length,
        "qayaba.candidates.shared_seeds": candidates.reduce((n, c) => n + (c.sharedSeeds?.length ?? 0), 0),      },
    }).end();
  } catch (err) {
    engineLog.error(`[telemetry] the candidates span could not be recorded (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
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
