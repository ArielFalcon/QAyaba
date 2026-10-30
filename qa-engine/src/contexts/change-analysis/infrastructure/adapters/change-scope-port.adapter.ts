/*
 * The reach of a change over the run's index (S3a). For each repo of the change: the changed symbols and what reaches them,
 * and the routes the engine recognised. A repo that holds the app's pages is walked in itself; a service's change reaches the
 * pages through the frontend call sites of the links the stitcher found reached, each proof opened by the link it crossed (a
 * link without a call-site symbol claims nothing). The proofs are strategies handed in; this adapter only asks the index and
 * hands the walks to `buildChangeScope`. Never throws: a repo whose index cannot answer is a `degraded` entry of the scope.
 */
import { engineLog } from "@kernel/ports/process-logger.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { GraphRoute, ImpactBudget, ImpactReport, LocalSymbolRef } from "@kernel/code/index.ts";
import type { ServiceLink } from "@kernel/service-links.ts";
import type { Attrs } from "@kernel/telemetry/attribute-registry.ts";
import { activeExecScope } from "../../../../shared-infrastructure/process-sandbox/exec-scope.ts";
import { walkAttrs, walkSummary } from "./structural-signal-port.adapter.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import { LanguageRegistry } from "@kernel/language-id.ts";
import type { PageMap } from "../../domain/page-files.ts";
import { buildChangeScope, changedSymbolOf, type ProofWalk, type ReachLink, type ReachProof } from "../../domain/reach-proof.ts";
import { entryKey, MAX_KNOWN_ENTRY_POINTS, type ChangeScope, type EntryPoint, type RepoScope } from "../../domain/change-scope.ts";
import { rankRoutesWithRelevance } from "@contexts/generation/application/index.ts";
import { deriveCandidates, type MapLink, type UseCaseCandidate } from "../../domain/use-case-candidate.ts";
import { readManifestTargets, readSuiteTexts } from "./suite-enrichment.ts";
import type { ChangeScopePort, ChangeScopeRepo, ChangeScopeRequest } from "../../application/ports/change-scope.port.ts";

export interface ChangeScopePortAdapterDeps {
  codeGraph: CodeGraphPort;
  budget: ImpactBudget;
  proofs: readonly ReachProof[];
  /* The app's context map, when one fits the run: enrichment only, never required. */
  loadMap?: (specDir: string) => PageMap | undefined;
  /* The non-code files each of `files` (source files of the mirror at `repoDir`) declares by relative path literal, read strictly from the mirror. Absent: no file is tied to the source that declares it. */
  declaredResources?: (files: readonly string[], repoDir: string) => ReadonlyMap<string, readonly string[]>;
}

const keyOf = (s: LocalSymbolRef): string => `${s.file}::${s.symbol}`;

export class ChangeScopePortAdapter implements ChangeScopePort {
  constructor(private readonly deps: ChangeScopePortAdapterDeps) {}

  async resolve(request: ChangeScopeRequest): Promise<ChangeScope> {
    /* An upstream hop of the cross-repo walk that could not be finished is as much a gap of the scope as an index that did not answer: the page it would have reached is missing. A downstream hop reaches no page, candidate or operation (grounding only), so it is no gap of the scope; the prompt and the run record carry it. */
    const degraded: Array<{ repo: string; reason: string }> = (request.crossRepoImpact?.stops ?? []).filter((stop) => stop.direction === "upstream").map((stop) => ({ repo: stop.repo, reason: `hop ${stop.direction}: ${stop.reason}` }));
    const repos: RepoScope[] = [];
    const walks: ProofWalk[] = [];
    const routesByDir = new Map<string, GraphRoute[]>();
    const routesOf = async (repo: string, repoDir: string): Promise<GraphRoute[]> => {
      const held = routesByDir.get(repoDir);
      if (held) return held;
      const answered = await this.deps.codeGraph.routes(repoDir);
      if (!answered.ok) {
        degraded.push({ repo, reason: `routes: ${answered.error.reason}` });
        routesByDir.set(repoDir, []);
        return [];
      }
      routesByDir.set(repoDir, answered.value);
      return answered.value;
    };

    const handlerRoutes: GraphRoute[] = [];
    let pageRepo: { repo: string; repoDir: string } | undefined;
    for (const r of request.repos) {
      try {
        const scope = await this.walkRepo(r, routesOf, degraded);
        repos.push(scope.repo);
        if (r.role === "primary") {
          pageRepo = { repo: r.repo, repoDir: r.repoDir };
          if (scope.walk) walks.push({ ...scope.walk, handlers: true });
          handlerRoutes.push(...(routesByDir.get(r.repoDir) ?? []));
        }
      } catch (err) {
        degraded.push({ repo: r.repo, reason: err instanceof Error ? err.message : String(err) });
        repos.push(emptyScope(r));
      }
    }

    const pages = pageRepo ?? request.pages;
    let pageRoutes: GraphRoute[] = [];
    try {
      if (pages) pageRoutes = await routesOf(pages.repo, pages.repoDir);
      const links = request.repos.some((r) => r.role === "service") ? await this.callSiteWalk(request, pages, degraded) : undefined;
      if (links) walks.push(links);
    } catch (err) {
      degraded.push({ repo: pages?.repo ?? request.repos[0]?.repo ?? "", reason: err instanceof Error ? err.message : String(err) });
    }

    const map = this.mapOf(request);
    const scope = buildChangeScope({ proofs: { map, walks, pageRoutes, handlerRoutes, links: linksOf(request) }, repos, degraded, linked: new Set() }, this.deps.proofs);
    note({
      "qayaba.change_scope.partial_seeds": scope.partialSeeds ?? [],
      "qayaba.change_scope.hub_nodes": scope.hubs.filter((h) => h.via === "fan-in").map((h) => `${h.symbol}: ${h.fanIn ?? 0}`),
    });
    return scope;
  }

  async candidates(request: { specDir: string; scope: ChangeScope }): Promise<UseCaseCandidate[]> {
    const map = this.mapOf(request);
    return deriveCandidates(request.scope, {
      map,
      mapLinks: mapLinksOf(request.scope, map),
      manifest: readManifestTargets(request.specDir),
      suiteFiles: readSuiteTexts(request.specDir),
    });
  }

  private mapOf(request: { specDir: string }): PageMap {
    try {
      return this.deps.loadMap?.(request.specDir) ?? {};
    } catch (err) {
      engineLog.error(`[qa] the context map could not be read for the change's scope (the scope goes on without it): ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }

  /* The change of one repo: its symbols and what reaches them, and the entry points the engine knows there. */
  private async walkRepo(
    r: ChangeScopeRepo,
    routesOf: (repo: string, repoDir: string) => Promise<GraphRoute[]>,
    degraded: Array<{ repo: string; reason: string }>,
  ): Promise<{ repo: RepoScope; walk?: ProofWalk }> {
    const changed = BlastRadius.of(Sha.of(r.headSha), [...r.changedFiles], r.touchedLines);
    const impact = await this.deps.codeGraph.impactedSymbols(r.repoDir, changed, this.deps.budget);
    const routes = await routesOf(r.repo, r.repoDir);
    const known = entryPointsOf(r.repo, routes);
    if (!impact.ok) {
      degraded.push({ repo: r.repo, reason: `walk: ${impact.error.reason}` });
      return { repo: { ...emptyScope(r), entryPoints: known.entryPoints, entryPointsTruncated: known.truncated } };
    }
    const { symbols, seedBasis, indexedSha } = impact.value;
    observeWalk(r.repo, impact.value);
    return {
      repo: {
        repo: r.repo,
        role: r.role,
        indexedSha,
        changedFiles: [...r.changedFiles],
        seeds: symbols.filter((s) => s.depth === 0).map(changedSymbolOf),
        seedBasis,
        ...(r.touchedLines ? { addedLines: addedLinesOf(r.touchedLines) } : {}),
        ...this.declaredIn(r),
        entryPoints: known.entryPoints,
        entryPointsTruncated: known.truncated,
      },
      walk: { repo: r.repo, reached: symbols, handlers: true, ...walkFacts(impact.value) },
    };
  }

  /* The changed non-code files the repo's changed source files declare, keyed by the source file; nothing when none of its changed files is a non-code file or none is declared. Fail-open: a read that throws ties nothing. */
  private declaredIn(r: ChangeScopeRepo): Pick<RepoScope, "declaredResources"> {
    const read = this.deps.declaredResources;
    const resources = new Set(r.changedFiles.filter((file) => LanguageRegistry.languageForFile(file) === null));
    if (!read || resources.size === 0) return {};
    try {
      const declared = [...read(r.changedFiles.filter((file) => !resources.has(file)), r.repoDir)].flatMap(([file, files]) => {
        const changed = files.filter((f) => resources.has(f));
        return changed.length > 0 ? [[file, changed] as const] : [];
      });
      return declared.length > 0 ? { declaredResources: Object.fromEntries(declared) } : {};
    } catch (err) {
      engineLog.error(`[qa] the files the change's source files declare could not be read (the scope goes on without them): ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }

  /*
   * A service's change on the app's pages: from the call sites of the links reached, inbound in the app's index. Only a call site
   * the app's index holds is a seed (a link whose call site is in another service claims nothing here), and a link reached
   * downstream is no way into a page. Each proof opens with the links crossed from the change, in order, then the link itself.
   */
  private async callSiteWalk(request: ChangeScopeRequest, pages: { repo: string; repoDir: string } | undefined, degraded: Array<{ repo: string; reason: string }>): Promise<ProofWalk | undefined> {
    const prefixOf = new Map<string, string[]>();
    const seeds: LocalSymbolRef[] = [];
    for (const { link, operationChange, reach } of request.crossRepoImpact?.impactedLinks ?? []) {
      /* An operation added by the change has no caller yet. */
      if (operationChange === "added") continue;
      if (reach?.direction === "downstream") continue;
      if (!link.from.file || !link.from.symbol) continue;
      if (pages !== undefined && link.from.repo !== pages.repo) continue;
      const seed = { file: link.from.file, symbol: link.from.symbol };
      if (prefixOf.has(keyOf(seed))) continue;
      prefixOf.set(keyOf(seed), [...(reach?.via ?? []).map((via) => describeLink(via)), describeLink(link, operationChange)]);
      seeds.push(seed);
    }
    if (seeds.length === 0) return undefined;
    if (!pages) {
      degraded.push({ repo: request.repos.find((r) => r.role === "service")?.repo ?? "", reason: "the app's own repo is not indexed, so the call sites of the service's links were not walked" });
      return undefined;
    }
    const walk = await this.deps.codeGraph.callersOf(pages.repoDir, seeds, this.deps.budget);
    if (!walk.ok) {
      degraded.push({ repo: pages.repo, reason: `walk from the call sites: ${walk.error.reason}` });
      return undefined;
    }
    observeWalk(pages.repo, walk.value);
    return { repo: pages.repo, reached: walk.value.symbols, prefixOf, handlers: false, ...walkFacts(walk.value) };
  }
}

/* A link as the evidence names it: the repo it lands in and the operation it calls. */
function describeLink(link: ServiceLink, operationChange?: "added" | "removed" | "changed"): string {
  const operation = link.operation ? `${link.operation.verb} ${link.operation.path}` : (link.contractRef ?? link.to.symbol ?? link.to.file);
  return `${link.to.repo}: ${operation}${operationChange === "removed" ? " (removed)" : ""}`;
}

/* What a walk's answer says about its seeds for the proofs: a lower bound, the partial seeds, the hubs it pruned. */
function walkFacts(report: ImpactReport): Pick<ProofWalk, "truncated" | "partialSeeds" | "hubNodes"> {
  return { truncated: report.truncated, partialSeeds: new Set((report.partialSeeds ?? []).map(keyOf)), hubNodes: report.hubNodes ?? [] };
}

/* The scope's walk facts go on the open phase's span; telemetry is advisory, so a fault here is logged and dropped. */
function note(attrs: Attrs): void {
  try {
    activeExecScope()?.telemetry?.annotate?.(attrs);
  } catch (cause) {
    engineLog.error(`[qa] change scope telemetry failed and was dropped: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/* A walk that left a seed partial or pruned a hub says so in the log and on the span; a complete one without hubs is silent. */
function observeWalk(repo: string, report: ImpactReport): void {
  note(walkAttrs(report));
  if (report.truncated || (report.hubNodes?.length ?? 0) > 0) engineLog.info(`[qa] change scope of ${repo}: ${walkSummary(report)}`);
}

/* The pages the map links to the files the app's own repo changed: its implementation files, its source, the spec of an operation it joins. */
function mapLinksOf(scope: ChangeScope, map: PageMap): MapLink[] {
  const primary = scope.repos.find((r) => r.role === "primary");
  const routes = (map.routes ?? []).flatMap((r) => (typeof r.path === "string" && r.path !== "" ? [r.path] : []));
  if (!primary || routes.length === 0 || primary.changedFiles.length === 0) return [];
  return rankRoutesWithRelevance(routes, map, { changedFiles: primary.changedFiles }).flatMap((ranked) =>
    ranked.relevant && ranked.files.length > 0 && (ranked.basis === "implementation" || ranked.basis === "source" || ranked.basis === "spec") ? [{ repo: primary.repo, route: ranked.route, basis: ranked.basis, files: ranked.files }] : [],
  );
}

/* The operations of the impacted links, one per operation. */
function linksOf(request: ChangeScopeRequest): ReachLink[] {
  const byKey = new Map<string, ReachLink>();
  for (const { link, operationChange, reach } of request.crossRepoImpact?.impactedLinks ?? []) {
    if (!link.operation || reach?.direction === "downstream") continue;
    const key = `${link.to.repo} ${link.operation.verb.toUpperCase()} ${link.operation.path}`;
    if (!byKey.has(key)) byKey.set(key, { repo: link.to.repo, verb: link.operation.verb.toUpperCase(), path: link.operation.path, file: link.to.file, confidence: link.confidence, ...(operationChange ? { change: operationChange } : {}) });
  }
  return [...byKey.values()];
}

function addedLinesOf(touched: ReadonlyMap<string, ReadonlySet<number>>): Record<string, number> {
  return Object.fromEntries([...touched].map(([file, lines]) => [file, lines.size]));
}

function emptyScope(r: ChangeScopeRepo): RepoScope {
  return { repo: r.repo, role: r.role, indexedSha: null, changedFiles: [...r.changedFiles], seeds: [], seedBasis: "none", ...(r.touchedLines ? { addedLines: addedLinesOf(r.touchedLines) } : {}), entryPoints: [], entryPointsTruncated: false };
}

/* Every route the engine recognised in the repo: a handler (it has a method) is an operation, any other is a page. Sorted, de-duplicated, capped. */
export function entryPointsOf(repo: string, routes: readonly GraphRoute[]): { entryPoints: EntryPoint[]; truncated: boolean } {
  const byKey = new Map<string, EntryPoint>();
  for (const route of routes) {
    const entry: EntryPoint = route.method !== undefined ? { kind: "operation", repo, verb: route.method.toUpperCase(), path: route.path } : { kind: "page", repo, route: route.path };
    byKey.set(entryKey(entry), entry);
  }
  const sorted = [...byKey].sort(([a], [b]) => a.localeCompare(b)).map(([, e]) => e);
  return { entryPoints: sorted.slice(0, MAX_KNOWN_ENTRY_POINTS), truncated: sorted.length > MAX_KNOWN_ENTRY_POINTS };
}
