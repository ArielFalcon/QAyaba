/*
 * The walks the change-page join reads, asked of the run's index (S10). In one repo: the change's symbols and what reaches
 * them, plus the routes the engine recognised (frontend pages and backend handlers alike). Across repos (a service's change
 * on its app's suite): the frontend call sites of the links the stitcher found reached, and what reaches them in the app's
 * index, each proof opened by the link it crossed; a link without a call-site symbol claims nothing. Never throws: an index
 * that cannot answer leaves the change's pages as the map has them (undefined).
 */
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { GraphRoute, ImpactBudget, LocalSymbolRef } from "@kernel/code/index.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import { joinChangePages, type ChangePagesJoin, type PageMap } from "../../domain/change-pages.ts";
import type { ChangePagesPort, ChangePagesRequest } from "../../application/ports/change-pages.port.ts";

export interface ChangePagesPortAdapterDeps {
  codeGraph: CodeGraphPort;
  /* The repo the run's change is in (its index). */
  repoDir: string;
  /* Across repos: the repo whose pages the map names (the app's own), when it is not the change's. */
  pagesRepoDir?: string;
  budget: ImpactBudget;
}

const keyOf = (s: LocalSymbolRef): string => `${s.file}::${s.symbol}`;

export class ChangePagesPortAdapter implements ChangePagesPort {
  constructor(private readonly deps: ChangePagesPortAdapterDeps) {}

  async resolve(request: ChangePagesRequest): Promise<ChangePagesJoin | undefined> {
    try {
      const { pagesRepoDir, repoDir } = this.deps;
      return pagesRepoDir !== undefined && pagesRepoDir !== repoDir ? await this.acrossRepos(request, pagesRepoDir) : await this.inOneRepo(request);
    } catch (err) {
      console.warn(`[qa] WARNING: the change's pages were not joined over the call graph (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private async inOneRepo(request: ChangePagesRequest): Promise<ChangePagesJoin | undefined> {
    const { codeGraph, repoDir, budget } = this.deps;
    const changed = BlastRadius.of(Sha.of(request.sha), [...request.changedFiles], request.touchedLines);
    const impact = await codeGraph.impactedSymbols(repoDir, changed, budget);
    if (!impact.ok) return this.unanswered("the change's walk", impact.error.reason);
    this.noteTruncated("the change's walk", impact.value.truncated);
    const routes = await this.routesOf(repoDir);
    return joinChangePages({ map: request.map as PageMap, walks: [{ reached: impact.value.symbols, handlers: true, truncated: impact.value.truncated }], pageRoutes: routes, handlerRoutes: routes, linked: request.linked });
  }

  private async acrossRepos(request: ChangePagesRequest, pagesRepoDir: string): Promise<ChangePagesJoin | undefined> {
    const prefixOf = new Map<string, string[]>();
    const seeds: LocalSymbolRef[] = [];
    for (const { link } of request.crossRepoImpact?.impactedLinks ?? []) {
      if (!link.from.file || !link.from.symbol) continue;
      const seed = { file: link.from.file, symbol: link.from.symbol };
      if (prefixOf.has(keyOf(seed))) continue;
      const operation = link.operation ? `${link.operation.verb} ${link.operation.path}` : (link.contractRef ?? link.to.symbol ?? link.to.file);
      prefixOf.set(keyOf(seed), [`${link.to.repo}: ${operation}`]);
      seeds.push(seed);
    }
    if (seeds.length === 0) return { pages: [], hubs: [], disagreements: [], omitted: 0 };
    const walk = await this.deps.codeGraph.callersOf(pagesRepoDir, seeds, this.deps.budget);
    if (!walk.ok) return this.unanswered("the walk from the frontend call sites", walk.error.reason);
    this.noteTruncated("the walk from the frontend call sites", walk.value.truncated);
    const routes = await this.routesOf(pagesRepoDir);
    return joinChangePages({ map: request.map as PageMap, walks: [{ reached: walk.value.symbols, prefixOf, handlers: false, truncated: walk.value.truncated }], pageRoutes: routes, handlerRoutes: [], linked: request.linked });
  }

  /* The engine's routes; none when it cannot answer (the map's own files still decide). */
  private async routesOf(repoDir: string): Promise<GraphRoute[]> {
    const routes = await this.deps.codeGraph.routes(repoDir);
    if (routes.ok) return routes.value;
    console.warn(`[qa] WARNING: the engine's routes could not be listed, so the map's files alone decide the change's pages (non-blocking): ${routes.error.reason}`);
    return [];
  }

  private unanswered(what: string, reason: string): undefined {
    console.warn(`[qa] WARNING: the index did not answer ${what}, so the change's pages are not joined over the call graph (non-blocking): ${reason}`);
    return undefined;
  }

  private noteTruncated(what: string, truncated: boolean): void {
    if (truncated) console.warn(`[qa] WARNING: ${what} was cut by its budget; a symbol of it is never taken for a non-hub and the pages it reaches are not added (non-blocking).`);
  }
}
