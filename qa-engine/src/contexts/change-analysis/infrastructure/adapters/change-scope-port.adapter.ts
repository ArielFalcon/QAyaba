/*
 * The reach of a change over the run's index (S3a). For each repo of the change: the changed symbols and what reaches them,
 * and the routes the engine recognised. A repo that holds the app's pages is walked in itself; a service's change reaches the
 * pages through the frontend call sites of the links the stitcher found reached, each proof opened by the link it crossed (a
 * link without a call-site symbol claims nothing). The proofs are strategies handed in; this adapter only asks the index and
 * hands the walks to `buildChangeScope`. Never throws: a repo whose index cannot answer is a `degraded` entry of the scope.
 */
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { GraphRoute, ImpactBudget, LocalSymbolRef } from "@kernel/code/index.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import type { PageMap } from "@kernel/page-files.ts";
import { buildChangeScope, changedSymbolOf, type ProofWalk, type ReachLink, type ReachProof } from "../../domain/reach-proof.ts";
import { entryKey, MAX_KNOWN_ENTRY_POINTS, type ChangeScope, type EntryPoint, type RepoScope } from "../../domain/change-scope.ts";
import type { ChangeScopePort, ChangeScopeRepo, ChangeScopeRequest } from "../../application/ports/change-scope.port.ts";

export interface ChangeScopePortAdapterDeps {
  codeGraph: CodeGraphPort;
  budget: ImpactBudget;
  proofs: readonly ReachProof[];
  /* The app's context map, when one fits the run: enrichment only, never required. */
  loadMap?: (specDir: string) => PageMap | undefined;
}

const keyOf = (s: LocalSymbolRef): string => `${s.file}::${s.symbol}`;

export class ChangeScopePortAdapter implements ChangeScopePort {
  constructor(private readonly deps: ChangeScopePortAdapterDeps) {}

  async resolve(request: ChangeScopeRequest): Promise<ChangeScope> {
    const degraded: Array<{ repo: string; reason: string }> = [];
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
    return buildChangeScope({ proofs: { map, walks, pageRoutes, handlerRoutes, links: linksOf(request) }, repos, degraded, linked: new Set() }, this.deps.proofs);
  }

  private mapOf(request: ChangeScopeRequest): PageMap {
    try {
      return this.deps.loadMap?.(request.specDir) ?? {};
    } catch (err) {
      console.error(`[qa] the context map could not be read for the change's scope (the scope goes on without it): ${err instanceof Error ? err.message : String(err)}`);
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
    const { symbols, truncated, seedBasis, indexedSha } = impact.value;
    return {
      repo: {
        repo: r.repo,
        role: r.role,
        indexedSha,
        changedFiles: [...r.changedFiles],
        seeds: symbols.filter((s) => s.depth === 0).map(changedSymbolOf),
        seedBasis,
        entryPoints: known.entryPoints,
        entryPointsTruncated: known.truncated,
      },
      walk: { repo: r.repo, reached: symbols, handlers: true, truncated },
    };
  }

  /* A service's change on the app's pages: from the call sites of the links reached, inbound in the app's index. */
  private async callSiteWalk(request: ChangeScopeRequest, pages: { repo: string; repoDir: string } | undefined, degraded: Array<{ repo: string; reason: string }>): Promise<ProofWalk | undefined> {
    const prefixOf = new Map<string, string[]>();
    const seeds: LocalSymbolRef[] = [];
    for (const { link, operationChange } of request.crossRepoImpact?.impactedLinks ?? []) {
      /* An operation added by the change has no caller yet. */
      if (operationChange === "added") continue;
      if (!link.from.file || !link.from.symbol) continue;
      const seed = { file: link.from.file, symbol: link.from.symbol };
      if (prefixOf.has(keyOf(seed))) continue;
      const operation = link.operation ? `${link.operation.verb} ${link.operation.path}` : (link.contractRef ?? link.to.symbol ?? link.to.file);
      prefixOf.set(keyOf(seed), [`${link.to.repo}: ${operation}${operationChange === "removed" ? " (removed)" : ""}`]);
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
    return { repo: pages.repo, reached: walk.value.symbols, prefixOf, handlers: false, truncated: walk.value.truncated };
  }
}

/* The operations of the impacted links, one per operation. */
function linksOf(request: ChangeScopeRequest): ReachLink[] {
  const byKey = new Map<string, ReachLink>();
  for (const { link, operationChange } of request.crossRepoImpact?.impactedLinks ?? []) {
    if (!link.operation) continue;
    const key = `${link.to.repo} ${link.operation.verb.toUpperCase()} ${link.operation.path}`;
    if (!byKey.has(key)) byKey.set(key, { repo: link.to.repo, verb: link.operation.verb.toUpperCase(), path: link.operation.path, file: link.to.file, confidence: link.confidence, ...(operationChange ? { change: operationChange } : {}) });
  }
  return [...byKey.values()];
}

function emptyScope(r: ChangeScopeRepo): RepoScope {
  return { repo: r.repo, role: r.role, indexedSha: null, changedFiles: [...r.changedFiles], seeds: [], seedBasis: "none", entryPoints: [], entryPointsTruncated: false };
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
