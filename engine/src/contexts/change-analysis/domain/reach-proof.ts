/*
 * Reach proofs and the scope they build. A proof is a strategy: it reads the walks the run's index answered and says which
 * entry points a changed symbol reaches and how. `buildChangeScope` runs every proof it is given, keeps the shortest evidence
 * per entry, withholds the entries of a hub, and orders what is left; a new proof kind is a new strategy in the list, never an
 * edit here. Nothing here resolves a contract or creates a link. Pure.
 *
 * A hub is a changed symbol whose proven entries of one kind exceed `hubEntries` (a partial seed too, when its lower bound
 * already does), or a node the walk pruned at its fan-in limit: the pages of its closure are its keys. A partial seed below the
 * limit keeps its entries, ranked after the complete ones; no absence is proven while one exists.
 */
import type { GraphRoute, HubNode, ImpactedSymbol } from "@kernel/code/index.ts";
import { keyOf, pageFiles, type PageMap } from "./page-files.ts";
import { entryKey, type ChangedSymbol, type ChangeScope, type EntryPoint, type ReachBasis, type ReachEntry, type ReachTier, type RepoScope, type ScopeHub } from "./change-scope.ts";

/* maxReach: the entries kept per kind (pages, operations); hubEntries: the entries of one kind past which a changed symbol is a hub. */
export const CHANGE_SCOPE_LIMITS = { maxReach: 6, hubEntries: 4 } as const;

/* One walk the index answered: the symbols reached (depth 0 are its seeds), what opens each proof (the link it crossed, across repos), and whether the walk is of the repo the map's operations belong to. */
export interface ProofWalk {
  repo: string;
  reached: readonly ImpactedSymbol[];
  /* The proof steps before a seed, by the seed's `file::symbol`; present for a walk that starts at a frontend call site. */
  prefixOf?: ReadonlyMap<string, readonly string[]>;
  handlers: boolean;
  /* What a seed reached is a lower bound: a seed is partial, or the change had more seeds than the walk took. */
  truncated?: boolean;
  /* The seeds the walk's budget left partial, by `file::symbol`. */
  partialSeeds?: ReadonlySet<string>;
  /* The nodes the walk pruned at its fan-in limit, each with its closure. */
  hubNodes?: readonly HubNode[];
}

/* A contract operation of a service that the change impacted, as the cross-repo impact left it. */
export interface ReachLink {
  repo: string;
  verb: string;
  path: string;
  /* The contract file the operation is declared in. */
  file: string;
  confidence: number;
  change?: "added" | "removed" | "changed";
}

export interface ProofInput {
  map: PageMap;
  walks: readonly ProofWalk[];
  /* The routes the engine recognised in the repo whose pages the map names, and in the walked repo for the handler proof. */
  pageRoutes: readonly GraphRoute[];
  handlerRoutes: readonly GraphRoute[];
  /* The operations of the services the change impacted. */
  links?: readonly ReachLink[];
}

export interface ReachHit {
  entry: EntryPoint;
  basis: ReachBasis;
  seed: ChangedSymbol;
  /* The hops from the seed to the symbol that proves the entry. */
  hops: number;
  evidence: string[];
  confidence: number;
  /* The seed's walk is partial: the hit stands, but the seed may reach more. */
  partial: boolean;
}

export interface ReachProof {
  readonly id: string;
  prove(input: ProofInput): readonly ReachHit[];
}

/* One reached symbol for one seed that reaches it, with the path the walk found first: that path's seed first. */
export interface WalkChain {
  symbol: ImpactedSymbol;
  seed: ImpactedSymbol;
  chain: ImpactedSymbol[];
  /* The evidence steps up to and including the symbol, after the walk's prefix for the path's seed. */
  steps: string[];
  /* The hops from `seed` to the symbol. */
  hops: number;
  /* `seed`'s walk is partial. */
  partial: boolean;
}

/*
 * One chain per (reached symbol, seed that reaches it): the seed `via` leads back to, with its path, and every other seed the
 * walk recorded for the symbol, with its own hops and the same path as evidence. A page two seeds reach counts for both.
 */
export function walkChains(walk: ProofWalk): WalkChain[] {
  const byKey = new Map(walk.reached.map((s) => [keyOf(s), s]));
  const partial = (s: ImpactedSymbol): boolean => walk.partialSeeds?.has(keyOf(s)) === true;
  return walk.reached.flatMap((symbol) => {
    const chain = [symbol];
    const seen = new Set([keyOf(symbol)]);
    let at = symbol;
    while (at.via !== undefined) {
      const next = byKey.get(keyOf(at.via));
      if (next === undefined || seen.has(keyOf(next))) break;
      chain.unshift(next);
      seen.add(keyOf(next));
      at = next;
    }
    const seed = chain[0]!;
    const steps = [...(walk.prefixOf?.get(keyOf(seed)) ?? []), ...chain.map(keyOf)];
    const others = (symbol.seeds ?? []).flatMap((reach) => {
      const other = byKey.get(keyOf(reach));
      return other === undefined || keyOf(other) === keyOf(seed) ? [] : [{ symbol, seed: other, chain, steps, hops: reach.hops, partial: partial(other) }];
    });
    return [{ symbol, seed, chain, steps, hops: chain.length - 1, partial: partial(seed) }, ...others];
  });
}

export function changedSymbolOf(s: ImpactedSymbol): ChangedSymbol {
  return { file: s.file, symbol: s.symbol, ...(s.range ? { range: s.range } : {}) };
}

/* Pure: how directly an entry is reached. A contract link is cross-repo; a map link of a changed file, or an implementing symbol within one call hop of a seed, is direct. */
export function tierOf(hit: Pick<ReachHit, "basis" | "hops">): ReachTier {
  if (hit.basis === "call-site" || hit.basis === "contract") return "cross-repo";
  if (hit.basis === "implementation" || hit.basis === "source" || hit.basis === "spec") return "direct";
  return hit.hops <= 1 ? "direct" : "indirect";
}

const TIER_ORDER: Readonly<Record<ReachTier, number>> = { direct: 0, "cross-repo": 1, indirect: 2 };

export interface ScopeInput {
  proofs: ProofInput;
  repos: readonly RepoScope[];
  degraded: ReadonlyArray<{ repo: string; reason: string }>;
  /* Pages the map already links to the change: they keep the map's basis and take no slot. */
  linked: ReadonlySet<string>;
  limits?: { maxReach: number; hubEntries: number };
}

/* The fan-in hubs of the walks: each pruned node, keyed by what the proofs prove over its closure from it. */
function fanInHubs(input: ScopeInput, proofs: readonly ReachProof[]): ScopeHub[] {
  return input.proofs.walks.flatMap((walk) =>
    (walk.hubNodes ?? []).map((hub): ScopeHub => {
      const symbol = keyOf(hub);
      const closure: ProofWalk = { repo: walk.repo, reached: hub.closure.symbols, handlers: walk.handlers, ...(walk.prefixOf ? { prefixOf: walk.prefixOf } : {}) };
      const keys = [...new Set(proofs.flatMap((proof) => proof.prove({ ...input.proofs, walks: [closure] })).filter((h) => keyOf(h.seed) === symbol).map((h) => entryKey(h.entry)))].sort();
      return { symbol, entries: keys.length, keys, via: "fan-in", fanIn: hub.fanIn, seeds: [...new Set(hub.seeds.map(keyOf))].sort(), ...(hub.closure.complete ? {} : { truncated: true as const }) };
    }),
  );
}

/* One hub per symbol: a changed symbol that is both over the entry limit and a pruned node holds the keys of both. */
function mergeHubs(hubs: readonly ScopeHub[]): ScopeHub[] {
  const out = new Map<string, ScopeHub>();
  for (const hub of hubs) {
    const held = out.get(hub.symbol);
    if (!held) {
      out.set(hub.symbol, hub);
      continue;
    }
    const keys = [...new Set([...held.keys, ...hub.keys])].sort();
    out.set(hub.symbol, { ...held, ...hub, keys, entries: keys.length, ...(held.truncated || hub.truncated ? { truncated: true as const } : {}) });
  }
  return [...out.values()].sort((a, b) => b.entries - a.entries || a.symbol.localeCompare(b.symbol));
}

export function buildChangeScope(input: ScopeInput, proofs: readonly ReachProof[]): ChangeScope {
  const limits = input.limits ?? CHANGE_SCOPE_LIMITS;
  const hits = proofs.flatMap((proof) => proof.prove(input.proofs));

  /* A seed reaching more entries of one kind than the limit is a hub; a partial one is, once its lower bound already does. */
  const keysOf = new Map<string, { page: Set<string>; operation: Set<string>; partial: boolean }>();
  for (const h of hits) {
    const seed = keyOf(h.seed);
    const held = keysOf.get(seed) ?? keysOf.set(seed, { page: new Set(), operation: new Set(), partial: false }).get(seed)!;
    held[h.entry.kind].add(entryKey(h.entry));
    held.partial ||= h.partial;
  }
  const overLimit = [...keysOf]
    .filter(([, k]) => k.page.size > limits.hubEntries || k.operation.size > limits.hubEntries)
    .map(([symbol, k]): ScopeHub => ({ symbol, entries: k.page.size + k.operation.size, keys: [...k.page, ...k.operation].sort(), ...(k.partial ? { truncated: true as const } : {}) }));
  const hubs = mergeHubs([...overLimit, ...fanInHubs(input, proofs)]);
  const hubSet = new Set(hubs.map((h) => h.symbol));

  const best = new Map<string, ReachHit[]>();
  for (const h of hits) {
    if (hubSet.has(keyOf(h.seed)) || (h.entry.kind === "page" && input.linked.has(h.entry.route))) continue;
    const key = entryKey(h.entry);
    best.set(key, [...(best.get(key) ?? []), h]);
  }
  /* An entry only partial seeds prove is ranked after the complete ones of its tier. */
  const partialOnly = new Set<string>();
  const reach: ReachEntry[] = [...best].map(([key, group]) => {
    const shortest = [...group].sort((a, b) => a.evidence.length - b.evidence.length || a.evidence.join(">").localeCompare(b.evidence.join(">")) || a.hops - b.hops)[0]!;
    const seeds = new Map<string, ChangedSymbol>();
    for (const h of group) seeds.set(keyOf(h.seed), h.seed);
    if (group.every((h) => h.partial)) partialOnly.add(key);
    return { entry: shortest.entry, tier: tierOf(shortest), basis: shortest.basis, evidence: shortest.evidence, seeds: [...seeds.values()], confidence: shortest.confidence };
  });
  const partialRank = (r: ReachEntry): number => (partialOnly.has(entryKey(r.entry)) ? 1 : 0);
  reach.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || partialRank(a) - partialRank(b) || b.confidence - a.confidence || a.evidence.length - b.evidence.length || entryKey(a.entry).localeCompare(entryKey(b.entry)));

  /* Pages and operations are capped each on their own: an operation never takes a page's slot. */
  const kept = new Map<ReachEntry["entry"]["kind"], number>();
  const capped = reach.filter((r) => {
    const n = kept.get(r.entry.kind) ?? 0;
    kept.set(r.entry.kind, n + 1);
    return n < limits.maxReach;
  });

  const partialSeeds = [...new Set(input.proofs.walks.flatMap((w) => [...(w.partialSeeds ?? [])]))].sort();
  return {
    repos: [...input.repos],
    reach: capped,
    hubs,
    disagreements: pageFiles(input.proofs.map, input.proofs.pageRoutes).disagreements,
    omitted: reach.length - capped.length,
    ...(input.proofs.walks.some((w) => w.truncated === true) ? { walksTruncated: true as const } : {}),
    ...(partialSeeds.length > 0 ? { partialSeeds } : {}),
    degraded: [...input.degraded],
  };
}
