/*
 * The pages of the app's map the call graph proves a change reaches, beside the ones the map links itself. The map stays the
 * source of page names: a page is always a route the map declares, and the graph only adds the proof that the change reaches
 * it. Three proofs are read from the walks the run's index answered:
 *   - a reached symbol lies in a file that implements a page (the map's implementation files; where the map declares none for a
 *     route, the file of the symbol the engine's route node for the same path points at);
 *   - a reached symbol is a handler whose route serves an operation of the map (verb and path, or the handler is named for the
 *     operationId), and the map's feBe joins that operation to a page;
 *   - across repos, a walk that starts at the frontend call site of a link the stitcher found reached (the first proof applies
 *     from there, the link's own description opening the proof).
 * Nothing here resolves a contract or creates a link: the stitcher's links and the map are taken as they are, and a symbol the
 * stitcher linked nothing to claims no page in another repo. A changed symbol that reaches more than `hubPages` pages is a hub:
 * it adds none and is reported with its count; so is a seed of a walk the budget cut, whose count is only a lower bound. At most `maxPages` pages are added, shortest proof first; the map's own pages
 * are never counted against that cap, nor removed. Where the engine and the map name different files for one page, the
 * disagreement is reported, never resolved. Pure.
 */
import type { GraphRoute, ImpactedSymbol } from "@kernel/code/index.ts";
import type { ChangePagesJoin } from "@kernel/change-pages.ts";
import { isText, keyOf, normalizeFile, pageFiles, pagesByOperation, sameFile, type PageMap } from "@kernel/page-files.ts";
import { routeServesOperation } from "@contexts/service-topology/domain/cross-repo-impact.ts";

export type { ChangePagesJoin, GraphPage } from "@kernel/change-pages.ts";

export type { PageMap };
export const GRAPH_PAGE_LIMITS = { maxPages: 6, hubPages: 4 } as const;


/* One walk the index answered: the symbols reached (depth 0 are its seeds), what opens each proof (the link it crossed, across repos), and whether the handler proof applies (the walk is of the repo the map's operations belong to). */
export interface PageWalk {
  reached: readonly ImpactedSymbol[];
  /* The proof steps before a seed, by the seed's `file::symbol`. */
  prefixOf?: ReadonlyMap<string, readonly string[]>;
  handlers: boolean;
  /* The budget cut the walk: the pages a seed reached are a lower bound, so no seed of it is proven a non-hub. */
  truncated?: boolean;
}

export interface ChangePagesInput {
  map: PageMap;
  walks: readonly PageWalk[];
  /* The routes the engine recognised in the repo whose pages the map names (frontend pages carry no method) and, for the handler proof, in the walked repo. */
  pageRoutes: readonly GraphRoute[];
  handlerRoutes: readonly GraphRoute[];
  /* Pages the map already links to the change: they keep the map's basis and take no slot. */
  linked: ReadonlySet<string>;
  limits?: { maxPages: number; hubPages: number };
}


export function joinChangePages(input: ChangePagesInput): ChangePagesJoin {
  const limits = input.limits ?? GRAPH_PAGE_LIMITS;
  const { files, disagreements } = pageFiles(input.map, input.pageRoutes);
  const joined = pagesByOperation(input.map);
  const operations = (input.map.api ?? []).filter((op) => op && isText(op.operationId) && isText(op.method) && isText(op.path)) as Array<{ operationId: string; method: string; path: string }>;

  /* Every proof found, per page and per seed; the shortest per page wins. */
  const proofs: Array<{ route: string; seed: string; proof: string[] }> = [];
  const cutSeeds = new Set<string>();
  for (const walk of input.walks) {
    const byKey = new Map(walk.reached.map((s) => [keyOf(s), s]));
    const chainOf = (s: ImpactedSymbol): ImpactedSymbol[] => {
      const chain = [s];
      const seen = new Set([keyOf(s)]);
      let at = s;
      while (at.via !== undefined) {
        const next = byKey.get(keyOf(at.via));
        if (next === undefined || seen.has(keyOf(next))) break;
        chain.unshift(next);
        seen.add(keyOf(next));
        at = next;
      }
      return chain;
    };
    for (const s of walk.reached) {
      const chain = chainOf(s);
      const seed = keyOf(chain[0]!);
      if (walk.truncated) cutSeeds.add(seed);
      const steps = [...(walk.prefixOf?.get(seed) ?? []), ...chain.map(keyOf)];
      const file = normalizeFile(s.file);
      for (const [route, implementing] of files) {
        if (implementing.some((f) => sameFile(f, file))) proofs.push({ route, seed, proof: [...steps, `page ${route}`] });
      }
      if (!walk.handlers) continue;
      /* S9's two keys: the symbol is named for the operationId (a generated contract interface yields no route node), or it is a handler whose route serves the operation. */
      const handled = input.handlerRoutes.filter((h) => h.method !== undefined && h.target !== undefined && keyOf(h.target) === keyOf(s));
      for (const op of operations) {
        const served = op.operationId === s.symbol || handled.some((h) => routeServesOperation({ method: h.method!, path: h.path }, { verb: op.method, path: op.path }));
        if (!served) continue;
        for (const route of joined.get(op.operationId) ?? []) proofs.push({ route, seed, proof: [...steps, `${op.method.toUpperCase()} ${op.path} (${op.operationId})`, `page ${route}`] });
      }
    }
  }

  const pagesOfSeed = new Map<string, Set<string>>();
  for (const p of proofs) pagesOfSeed.set(p.seed, (pagesOfSeed.get(p.seed) ?? new Set()).add(p.route));
  const hubs = [...pagesOfSeed].filter(([symbol, pages]) => pages.size > limits.hubPages || cutSeeds.has(symbol)).map(([symbol, pages]) => ({ symbol, pages: pages.size, routes: [...pages].sort(), ...(cutSeeds.has(symbol) ? { truncated: true } : {}) })).sort((a, b) => b.pages - a.pages || a.symbol.localeCompare(b.symbol));
  const hubSet = new Set(hubs.map((h) => h.symbol));

  const best = new Map<string, string[]>();
  for (const p of proofs) {
    if (hubSet.has(p.seed) || input.linked.has(p.route)) continue;
    const held = best.get(p.route);
    if (held === undefined || p.proof.length < held.length || (p.proof.length === held.length && p.proof.join(">") < held.join(">"))) best.set(p.route, p.proof);
  }
  const ranked = [...best].map(([route, proof]) => ({ route, proof })).sort((a, b) => a.proof.length - b.proof.length || a.route.localeCompare(b.route));
  return { pages: ranked.slice(0, limits.maxPages), hubs, disagreements, omitted: Math.max(0, ranked.length - limits.maxPages) };
}
