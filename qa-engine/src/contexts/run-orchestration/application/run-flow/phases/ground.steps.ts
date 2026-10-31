/* The ground phase of a run: what the agent is handed before it writes anything. The blast radius, the service links and the cross-repo impact resolved; together they make the enrichment every generation starts from. */

import type { Lesson } from "@contexts/cross-run-learning/application/index.ts";
import { engineLog } from "@kernel/ports/process-logger.ts";
import type { ServiceLink, ContractDrift, CrossRepoImpact, ImpactDirection, ImpactedLink, ImpactStop } from "@kernel/service-links.ts";
import { PRE_GENERATION_GROUNDING_STEP_DETAIL } from "@kernel/run-step.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import type { PageDataRead } from "@kernel/page-data-read.ts";
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";
import type { DecisionListing } from "@kernel/changed-decision.ts";
import type { ChangeScope, ChangeScopeRepo, ReachTier, UseCaseCandidate } from "@contexts/change-analysis/application/index.ts";
import type { StepOutcome } from "../run-flow.ts";
import { throwIfAborted } from "../abort.ts";
import type { WorkspaceRunContext } from "../run-context.ts";
import type { RunState } from "../run-state.ts";
import { carryOn } from "../failure-policy.ts";
import { recordRunFact } from "../reducers.ts";
import { indexOne } from "./opening.steps.ts";
import { LinkGraph, LinkWalk, type HopResult } from "@contexts/service-topology/application/index.ts";
import { Sha } from "@kernel/sha.ts";
import { availabilityGroundingOf, withRouteConfigCandidates } from "../route-availability-grounding.ts";

type Result = Promise<StepOutcome<RunState>>;

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
  let groundingDataContradictions: RunState["grounding"]["dataContradictions"];
  let groundingPageReads: PageDataRead[] | undefined;
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
      groundingDataContradictions = grounding.dataContradictions;
      groundingContextPack = grounding.contextPack;
      groundingContextPackItemIds = grounding.contextPackItemIds;
      groundingContextPackOmissions = grounding.contextPackOmissions;
      groundingExistingSpecFiles = grounding.existingSpecFiles;
      groundingContextMap = grounding.contextMap;
      groundingHarnessFacts = grounding.harnessFacts;
      groundingMoreNodes = grounding.changedValuesWithMoreNodes ?? [];
      groundingConfirmedDataRoutes = grounding.packConfirmedDataRoutes;
      groundingPageReads = grounding.pageReads;
      if (grounding.changedDecisions) {
        groundingChangedDecisions = grounding.changedDecisions.decisions;
        recordDecisions(ctx, grounding.changedDecisions);
      }
    } catch (err) {
      const level = carryOn(err);
      /* Abort during grounding takes the abort route, not ungrounded continue. */
      throwIfAborted(signal);
      engineLog[level]("[qa] WARNING: pre-generation grounding failed (non-fatal, generation continues ungrounded):", { error: err });
    }
  }
  await recordPageReads(state, ctx, groundingPageReads);
  const lessons = await deriveLessonsFor(ctx, groundingPageReads);
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
        lessons,
        changedDecisions: groundingChangedDecisions,
        routeAvailability: groundingRouteAvailability,
        dataContradictions: groundingDataContradictions,
        /* A route the change governs that the capture saw sent away is a use case to assert, named or not by the scope. */
        candidates: groundingRouteAvailability?.facts.length
          ? withRouteConfigCandidates(state.grounding.candidates, groundingRouteAvailability.facts, input.changeSet.anchor.repo)
          : state.grounding.candidates,
      },
    },
  };
}

/*
 * What the pack read of DEV's data is recorded as observations while the run is still deciding nothing: every run writes its reads, and the
 * verdict, which is not yet known, is never an input. Off-path: a fault in the store is said and the run goes on without the record.
 */
async function recordPageReads(state: Readonly<RunState>, ctx: WorkspaceRunContext, reads: readonly PageDataRead[] | undefined): Promise<void> {
  const recorder = ctx.deps.lessonRecorder;
  if (!recorder || !reads?.length) return;
  try {
    const tally = await recorder.record({
      app: ctx.input.app,
      runId: ctx.input.runId,
      sha: ctx.input.sha.toString(),
      repo: ctx.input.changeSet.anchor.repo,
      servedState: state.run.servedVersion?.state ?? "undeclared",
      at: new Date().toISOString(),
      reads,
    });
    recordRunFact(state, "lessons", tally);
  } catch (err) {
    engineLog.error("[qa] WARNING: the pages read of DEV could not be recorded as observations (non-fatal, the run goes on):", { error: err });
  }
}

/*
 * What earlier runs' observations teach about the pages this run read: only the observations written before this run started, and only when the
 * run's lessons lever is on (the port is absent otherwise). Off-path: a fault is said and the run goes on without lessons.
 */
async function deriveLessonsFor(ctx: WorkspaceRunContext, reads: readonly PageDataRead[] | undefined): Promise<readonly Lesson[]> {
  const port = ctx.deps.lessons;
  if (!port || !reads?.length) return [];
  try {
    return await port.derive({ app: ctx.input.app, scopes: [...new Set(reads.map((read) => read.scope))], before: new Date(ctx.startedAt).toISOString() });
  } catch (err) {
    engineLog.error("[qa] WARNING: the lessons of the pages read could not be derived (non-fatal, the run goes on without them):", { error: err });
    return [];
  }
}

/*
 * Built from the classified intent's changed files. Empty outside diff mode.
 * The same BlastRadius is reused for measure().
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
        const level = carryOn(err);
        engineLog[level]("[qa] WARNING: cross-repo impact resolution failed (non-fatal, generation continues without it):", { error: err });
      }
    }
  }
  const firstHop = impacts.length <= 1 ? (impacts[0] ?? null) : mergeImpacts(impacts);
  const crossRepoImpact = await followLinks(firstHop, state, ctx);
  return { update: { grounding: { ...state.grounding, crossRepoImpact } } };
}

/* The most of a stop's reason that reaches the prompt and the record. */
const STOP_REASON_MAX_CHARS = 400;

/*
 * The walk of RFC-0011 beyond the first hop, in both directions over the links the run resolved: upstream from the impact of
 * each changed service, downstream from the change of each changed repo whose links lead onward. Null when neither found a
 * link or a hop it could not finish.
 */
async function followLinks(firstHop: CrossRepoImpact | null, state: Readonly<RunState>, ctx: WorkspaceRunContext): Promise<CrossRepoImpact | null> {
  const links = state.grounding.serviceLinks;
  const indexes = new Map<string, HopIndex>();
  const graph = new LinkGraph(links);
  const port = ctx.deps.crossRepoImpact;
  const upstream = firstHop && port?.resolveUpstreamHop ? await walkHops(ctx, graph, "upstream", firstHop.impactedLinks, indexes, (request) => port.resolveUpstreamHop!({ ...request, links })) : undefined;
  const downstream = await followDownstream(state, ctx, graph, indexes);
  const impactedLinks = [...(firstHop?.impactedLinks ?? []), ...(upstream?.links ?? []), ...downstream.links];
  /* A reason is engine, git or error text on its way to the agent's prompt: redacted first, cut after. */
  const stops = [...(firstHop?.stops ?? []), ...(upstream?.stops ?? []), ...downstream.stops].map((stop) => ({ ...stop, reason: ctx.host.boundText(stop.reason, STOP_REASON_MAX_CHARS) }));
  if (impactedLinks.length === 0 && stops.length === 0) return null;
  return { impactedLinks, ...(stops.length > 0 ? { stops } : {}) };
}

/* The change of each repo of the run that has an index and a chain of two links starting at it, then the links beyond what it reaches. An app that declares no link leading onward keeps the one hop it always had. */
async function followDownstream(state: Readonly<RunState>, ctx: WorkspaceRunContext, graph: LinkGraph, indexes: Map<string, HopIndex>): Promise<WalkedLinks> {
  const port = ctx.deps.crossRepoImpact;
  const links = state.grounding.serviceLinks;
  if (!port?.resolveDownstream || !port.resolveDownstreamHop) return { links: [], stops: [] };
  const first: ImpactedLink[] = [];
  const stops: ImpactStop[] = [];
  for (const r of changeRepos(state, ctx).repos) {
    if (!graph.hasOnward(r.repo)) continue;
    throwIfAborted(ctx.signal);
    try {
      const hop = await port.resolveDownstream({ repo: r.repo, repoDir: r.repoDir, blast: BlastRadius.of(Sha.of(r.headSha), [...r.changedFiles], r.touchedLines), links });
      first.push(...hop.links);
      stops.push(...hop.stops);
    } catch (err) {
      const level = carryOn(err);
      engineLog[level](`[qa] WARNING: the downstream impact of ${r.repo} failed (non-fatal, nothing is claimed downstream of it):`, { error: err });
      stops.push({ repo: r.repo, direction: "downstream", reason: `walk failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  const beyond = await walkHops(ctx, graph, "downstream", first, indexes, (request) => port.resolveDownstreamHop!({ ...request, links }));
  return { links: [...first, ...beyond.links], stops: [...stops, ...beyond.stops] };
}

interface WalkedLinks {
  links: ImpactedLink[];
  stops: ImpactStop[];
}

/*
 * The hops after the first (RFC-0011): the repos the fresh links feed are walked, in repo order, with every link that feeds each
 * together, until a hop finds no link that was not admitted before. Termination is the set of links, not a count of hops. A
 * repo whose index cannot be had is a stop, not a failure, and nothing is claimed beyond it. Returns the links of the hops
 * after the first; `first` is admitted to the walk here.
 */
async function walkHops(
  ctx: WorkspaceRunContext,
  graph: LinkGraph,
  direction: ImpactDirection,
  first: readonly ImpactedLink[],
  indexes: Map<string, HopIndex>,
  hop: (request: { repo: string; repoDir: string; fed: ImpactedLink[] }) => Promise<HopResult>,
): Promise<WalkedLinks> {
  const found: ImpactedLink[] = [];
  const stops: ImpactStop[] = [];
  const walk = new LinkWalk(direction);
  let fresh = walk.admit(first);
  while (fresh.length > 0) {
    const next: ImpactedLink[] = [];
    for (const { repo, fed } of graph.frontier(direction, fresh)) {
      throwIfAborted(ctx.signal);
      const index = await indexForHop(ctx, repo, indexes);
      if (!index.ok) {
        stops.push({ repo, direction, reason: index.reason });
        continue;
      }
      try {
        const result = await hop({ repo, repoDir: index.repoDir, fed });
        next.push(...result.links);
        stops.push(...result.stops);
      } catch (err) {
        const level = carryOn(err);
        engineLog[level](`[qa] WARNING: the cross-repo hop through ${repo} failed (non-fatal, the walk stops there):`, { error: err });
        stops.push({ repo, direction, reason: `hop failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    fresh = walk.admit(next);
    found.push(...fresh);
  }
  return { links: found, stops };
}

type HopIndex = { ok: true; repoDir: string } | { ok: false; reason: string };

/* The directory a repo of the run was indexed from at the opening: the classify-source repo, the primary repo of a service-triggered run, and each other entry of the change. */
function indexedDirOf(ctx: WorkspaceRunContext, repo: string): string | undefined {
  const { deps, input } = ctx;
  if (repo === input.changeSet.anchor.repo) return deps.codeGraphRepoDir ?? ctx.services.specRoot.mirrorDir;
  if (deps.codeGraphPrimary?.repo === repo) return deps.codeGraphPrimary.repoDir;
  return deps.codeGraphRepoDirs?.get(repo);
}

/* The index a hop walks: the one the run already built, else the repo's mirror indexed now at the commit it holds (once per repo), else why there is none. */
async function indexForHop(ctx: WorkspaceRunContext, repo: string, held: Map<string, HopIndex>): Promise<HopIndex> {
  const built = indexedDirOf(ctx, repo);
  if (built) return { ok: true, repoDir: built };
  const memo = held.get(repo);
  if (memo) return memo;
  const result = await indexMirrorOf(ctx, repo);
  held.set(repo, result);
  return result;
}

async function indexMirrorOf(ctx: WorkspaceRunContext, repo: string): Promise<HopIndex> {
  const { deps } = ctx;
  if (!deps.codeGraph) return { ok: false, reason: "the run has no code graph to index the repo with" };
  const mirror = deps.codeGraphMirrors?.get(repo);
  if (!mirror) return { ok: false, reason: "the repo has no mirror to index in this run" };
  let head: string | null;
  try {
    head = await mirror.headSha();
  } catch (err) {
    engineLog.warn(`[qa] the commit of ${repo}'s mirror could not be read; it is not indexed this run:`, { error: err });
    return { ok: false, reason: "the commit of the repo's mirror could not be read" };
  }
  if (!head) return { ok: false, reason: "the commit of the repo's mirror could not be read" };
  const record = await indexOne(ctx, deps.codeGraph, mirror.repoDir, head);
  if (!record) return { ok: false, reason: "indexing failed" };
  if (record.outcome === "failed" || record.outcome === "timeout" || record.outcome === "skipped") return { ok: false, reason: `index ${record.outcome}${record.reason ? `: ${record.reason}` : ""}` };
  return { ok: true, repoDir: mirror.repoDir };
}

/* The first hops of several changed services. Each link has one target repo, so the lists of two services cannot hold the same link: nothing is de-duplicated here. */
function mergeImpacts(impacts: readonly CrossRepoImpact[]): CrossRepoImpact {
  const stops = impacts.flatMap((i) => i.stops ?? []);
  return {
    impactedLinks: impacts.flatMap((i) => i.impactedLinks),
    ...(stops.length > 0 ? { stops } : {}),
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
  const { repos, skipped } = changeRepos(state, ctx);
  let scope: ChangeScope;
  try {
    scope = await deps.changeScope.resolve({
      specDir: workspace.specDir,
      repos,
      ...(deps.codeGraphPrimary ? { pages: { repo: deps.codeGraphPrimary.repo, repoDir: deps.codeGraphPrimary.repoDir } } : {}),
      crossRepoImpact: state.grounding.crossRepoImpact,
    });
  } catch (err) {
    const level = carryOn(err);
    engineLog[level]("[qa] WARNING: the change scope could not be computed (non-fatal, the run goes on without it):", { error: err });
    scope = { repos: [], reach: [], hubs: [], disagreements: [], omitted: 0, degraded: [{ repo: input.changeSet.anchor.repo, reason: err instanceof Error ? err.message : String(err) }] };
  }
  const withSkipped: ChangeScope = skipped.length > 0 ? { ...scope, degraded: [...scope.degraded, ...skipped] } : scope;
  recordScope(ctx, withSkipped);
  let candidates: UseCaseCandidate[] = [];
  try {
    candidates = await deps.changeScope.candidates({ specDir: workspace.specDir, scope: withSkipped });
  } catch (err) {
    const level = carryOn(err);
    engineLog[level]("[qa] WARNING: the use-case candidates could not be derived (non-fatal, the run goes on without them):", { error: err });
  }
  recordCandidates(ctx, candidates);
  return { update: { grounding: { ...state.grounding, changeScope: withSkipped, candidates } } };
}

/* The repos of the run's change that have an index, each as the run read it, and those that have none. */
function changeRepos(state: Readonly<RunState>, ctx: WorkspaceRunContext): { repos: ChangeScopeRepo[]; skipped: Array<{ repo: string; reason: string }> } {
  const { deps, input } = ctx;
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
  return { repos, skipped };
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
  const { contextPack, contextPackItemIds, contextPackOmissions, existingSpecFiles, contextMap, harnessFacts, blastRadiusSignal, blastRadiusSignalHasSymbols, blastRadiusSignalFiles, serviceLinks, contractDrift, crossRepoImpact } = state.grounding;
  const baseEnrichment = {
    sha: input.sha.toString(),
    runId: input.runId,
    ...(classificationIntent ? { intent: classificationIntent } : {}),
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
    ...(closedLoop ? { closedLoop: closedLoop.limits } : {}),
    ...(agentBrowser ? { agentBrowser: agentBrowser.limits } : {}),
    ...(serviceLinks.length ? { serviceLinks } : {}),
    ...(contractDrift.length ? { contractDrift } : {}),
    ...(crossRepoImpact?.impactedLinks.length || crossRepoImpact?.stops?.length
      ? { crossRepoImpact: { impactedLinks: crossRepoImpact.impactedLinks, ...(crossRepoImpact.stops?.length ? { stops: crossRepoImpact.stops } : {}) } }
      : {}),
    /* contradiction is spread only when true — never fabricated as false. */
    ...(classificationReason ? { classificationReason } : {}),
    ...(classificationContradiction ? { contradiction: true } : {}),
  };
  return { update: { grounding: { ...state.grounding, baseEnrichment } } };
}
