/*
 * Reach proofs and the scope they build. A proof is a strategy: it reads the walks the run's index answered and says which
 * entry points a changed symbol reaches and how. `buildChangeScope` runs every proof it is given, keeps the shortest evidence
 * per entry, withholds the entries of a hub, and orders what is left; a new proof kind is a new strategy in the list, never an
 * edit here. Nothing here resolves a contract or creates a link. Pure.
 */
import type { GraphRoute, ImpactedSymbol } from "@kernel/code/index.ts";
import { keyOf, pageFiles, type PageMap } from "./page-files.ts";
import { entryKey, type ChangedSymbol, type ChangeScope, type EntryPoint, type ReachBasis, type ReachEntry, type ReachTier, type RepoScope } from "./change-scope.ts";

/* maxReach: the entries kept per kind (pages, operations); hubEntries: the entries of one kind past which a changed symbol is a hub. */
export const CHANGE_SCOPE_LIMITS = { maxReach: 6, hubEntries: 4 } as const;

/* One walk the index answered: the symbols reached (depth 0 are its seeds), what opens each proof (the link it crossed, across repos), and whether the walk is of the repo the map's operations belong to. */
export interface ProofWalk {
  repo: string;
  reached: readonly ImpactedSymbol[];
  /* The proof steps before a seed, by the seed's `file::symbol`; present for a walk that starts at a frontend call site. */
  prefixOf?: ReadonlyMap<string, readonly string[]>;
  handlers: boolean;
  /* The budget cut the walk: what a seed reached is a lower bound, so no seed of it is proven a non-hub. */
  truncated?: boolean;
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
  seedCut: boolean;
}

export interface ReachProof {
  readonly id: string;
  prove(input: ProofInput): readonly ReachHit[];
}

/* One reached symbol with the path from its seed: the seed first. */
export interface WalkChain {
  symbol: ImpactedSymbol;
  seed: ImpactedSymbol;
  chain: ImpactedSymbol[];
  /* The evidence steps up to and including the symbol, after the walk's prefix for the seed. */
  steps: string[];
}

export function walkChains(walk: ProofWalk): WalkChain[] {
  const byKey = new Map(walk.reached.map((s) => [keyOf(s), s]));
  return walk.reached.map((symbol) => {
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
    return { symbol, seed, chain, steps: [...(walk.prefixOf?.get(keyOf(seed)) ?? []), ...chain.map(keyOf)] };
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

export function buildChangeScope(input: ScopeInput, proofs: readonly ReachProof[]): ChangeScope {
  const limits = input.limits ?? CHANGE_SCOPE_LIMITS;
  const hits = proofs.flatMap((proof) => proof.prove(input.proofs));

  /* A seed reaching more entries of one kind than the limit is a hub; so is a seed of a walk the budget cut. */
  const keysOf = new Map<string, { page: Set<string>; operation: Set<string>; cut: boolean }>();
  for (const h of hits) {
    const seed = keyOf(h.seed);
    const held = keysOf.get(seed) ?? keysOf.set(seed, { page: new Set(), operation: new Set(), cut: false }).get(seed)!;
    held[h.entry.kind].add(entryKey(h.entry));
    held.cut ||= h.seedCut;
  }
  const hubs = [...keysOf]
    .filter(([, k]) => k.page.size > limits.hubEntries || k.operation.size > limits.hubEntries || k.cut)
    .map(([symbol, k]) => ({ symbol, entries: k.page.size + k.operation.size, keys: [...k.page, ...k.operation].sort(), ...(k.cut ? { truncated: true as const } : {}) }))
    .sort((a, b) => b.entries - a.entries || a.symbol.localeCompare(b.symbol));
  const hubSet = new Set(hubs.map((h) => h.symbol));

  const best = new Map<string, ReachHit[]>();
  for (const h of hits) {
    if (hubSet.has(keyOf(h.seed)) || (h.entry.kind === "page" && input.linked.has(h.entry.route))) continue;
    const key = entryKey(h.entry);
    best.set(key, [...(best.get(key) ?? []), h]);
  }
  const reach: ReachEntry[] = [...best].map(([, group]) => {
    const shortest = [...group].sort((a, b) => a.evidence.length - b.evidence.length || a.evidence.join(">").localeCompare(b.evidence.join(">")))[0]!;
    const seeds = new Map<string, ChangedSymbol>();
    for (const h of group) seeds.set(keyOf(h.seed), h.seed);
    return { entry: shortest.entry, tier: tierOf(shortest), basis: shortest.basis, evidence: shortest.evidence, seeds: [...seeds.values()], confidence: shortest.confidence };
  });
  reach.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.confidence - a.confidence || a.evidence.length - b.evidence.length || entryKey(a.entry).localeCompare(entryKey(b.entry)));

  /* Pages and operations are capped each on their own: an operation never takes a page's slot. */
  const kept = new Map<ReachEntry["entry"]["kind"], number>();
  const capped = reach.filter((r) => {
    const n = kept.get(r.entry.kind) ?? 0;
    kept.set(r.entry.kind, n + 1);
    return n < limits.maxReach;
  });

  return {
    repos: [...input.repos],
    reach: capped,
    hubs,
    disagreements: pageFiles(input.proofs.map, input.proofs.pageRoutes).disagreements,
    omitted: reach.length - capped.length,
    degraded: [...input.degraded],
  };
}
