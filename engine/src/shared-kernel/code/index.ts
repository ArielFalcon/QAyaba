/* Intra-repo structural VOs spoken by CodeGraphPort and CoChangePort. LocalSymbolRef is intra-repo and is distinct from service-topology's ServiceSymbolRef (cross-repo, carries a repo identity). Never name a transport, an engine or a watched-app literal here: what crosses these types is repo-relative POSIX paths and symbol names. */

/** An intra-repo symbol: a repo-relative file path plus the symbol name within it. */
export interface LocalSymbolRef {
  file: string;
  symbol: string;
}

/** A file that historically co-changes with a queried file (git-history co-change coupling). */
export interface CoupledFile {
  file: string;
  couplingScore: number;
  coChanges: number;
  lastCoChange?: string;
}

/** Typed failure: the graph is unavailable for a query (not indexed for this run, the engine failed or timed out, an answer that did not parse). Query methods fail open — a consumer treats this as "no structural signal", never as a hard error. */
export interface CodeGraphUnavailable {
  reason: string;
}

/** How a run's index of one repo came to be. `reused`: the cached store was already at the run's commit; `synced`: the cached store was brought up to it; `built`: indexed from nothing; `skipped`: not indexed (the signal is off, or the repo holds no file of a declared language). */
export const INDEX_OUTCOMES = ["built", "synced", "reused", "failed", "timeout", "skipped"] as const;
export type IndexOutcome = (typeof INDEX_OUTCOMES)[number];

/** The provenance of a run's index of one repo: which engine, at which commit, how it came to be and what it holds. Every answer the graph gives in that run carries this SHA. */
export interface CodeGraphIndexRecord {
  /** The repo's cache key (its mirror's name). */
  repo: string;
  engine: string;
  /** Null when the engine never answered (a failure before the status). */
  engineVersion: string | null;
  sha: string;
  outcome: IndexOutcome;
  durationMs: number;
  nodeCount: number | null;
  edgeCount: number | null;
  /** Why a failed, timed-out or skipped index is so. */
  reason?: string;
}

/** A changed symbol that reaches a node, and in how many hops it does. */
export interface SeedReach extends LocalSymbolRef {
  hops: number;
}

/**
 * A symbol the graph reached from a change: depth 0 is a changed symbol itself; `via` is the symbol one hop closer to the change
 * on the path that reached it first. `confidence` is the lowest confidence of an edge on that path (1 for a changed symbol or an
 * edge that states none): evidence for a consumer to weigh, never a filter. `range` is the line span of a changed symbol (depth 0
 * only). `seeds` names every changed symbol that reaches it within the walk's depth, not only the one `via` leads back to.
 */
export interface ImpactedSymbol extends LocalSymbolRef {
  kind: string;
  depth: number;
  confidence: number;
  range?: { start: number; end: number };
  via?: LocalSymbolRef;
  seeds?: SeedReach[];
}

/** Where a walk's seeds came from: the symbols holding the touched lines, every symbol of the changed files (the diff was not read), or no symbol at all. */
export type SeedBasis = "lines" | "whole-file" | "none";

/**
 * How an impact walk spends its work; one policy serves every caller. `depth` bounds the hops. A node with more callers than the
 * fan-in limit is a hub, recorded and not expanded: the limit is the index's own in-degree at `fanIn.percentile`, clamped to
 * `[floor, ceiling]`. `expansions` bounds the caller queries of a walk, `clamp(base + perSeed × seeds, floor, ceiling)`; when it
 * is spent the seeds still expanding are partial. `closures.expansions` bounds the queries of all the hubs' closures together.
 */
export interface WalkPolicy {
  depth: number;
  fanIn: { percentile: number; floor: number; ceiling: number };
  expansions: { base: number; perSeed: number; floor: number; ceiling: number };
  closures: { expansions: number };
}

/*
 * Measured on one Angular index (the seeds of a 3-commit run, depth 3), test-file callers excluded: the p99 fan-in
 * is 12, which leaves one hub and reaches 13 of the change's 15 pages, where a limit of 5 (the p95 with test callers) loses 9;
 * above 64 sit only the app-wide services; a complete walk took 209 to 457 expansions. One index is the whole evidence: re-measure
 * on another stack with the walk profile before moving a value.
 */
export const DEFAULT_WALK_POLICY: WalkPolicy = {
  depth: 3,
  fanIn: { percentile: 99, floor: 10, ceiling: 64 },
  expansions: { base: 1500, perSeed: 25, floor: 1500, ceiling: 4000 },
  closures: { expansions: 1500 },
};

/** The name the code-graph port gives the policy it walks under. */
export type ImpactBudget = WalkPolicy;

/** The caller queries a walk of `seeds` seeds may make under the policy. */
export function expansionBudget(policy: WalkPolicy, seeds: number): number {
  const { base, perSeed, floor, ceiling } = policy.expansions;
  return Math.min(Math.max(base + perSeed * seeds, floor), ceiling);
}

/** A route node the walk reached: an entry point, never expanded. `seeds` are the changed symbols that reach it. */
export interface ReachedRoute {
  file: string;
  line: number;
  method?: string;
  path: string;
  depth: number;
  via?: LocalSymbolRef;
  seeds: SeedReach[];
}

/** A node whose fan-in is above the walk's limit: recorded and not expanded. `closure` is what it reaches within the depth left; `complete` is false when a budget cut it. */
export interface HubNode extends LocalSymbolRef {
  kind: string;
  fanIn: number;
  depth: number;
  seeds: LocalSymbolRef[];
  closure: { symbols: ImpactedSymbol[]; complete: boolean };
}

/** What a walk spent: caller queries against its budget, the fan-in limit it used, and its closures' queries. */
export interface WalkCost {
  expansions: number;
  budget: number;
  fanInLimit?: number;
  closureExpansions: number;
  closureBudget: number;
}

/**
 * A walk's answer, ordered by (depth, file, line, symbol). `truncated` says what a seed reached is a lower bound: a seed is
 * partial (the expansion budget left part of its frontier open) or the change had more seeds than the reader takes.
 * `partialSeeds` names the partial ones, `hubNodes` the nodes pruned at the fan-in limit, `routes` the route nodes reached.
 * `indexedSha` is the commit of the index it read. `seedBasis` says what the depth-0 symbols stand for. `containers` names the
 * classes the walk lifted from a changed member: not changed themselves, but what names one (a route's guard) is touched.
 */
export interface ImpactReport {
  indexedSha: string;
  symbols: ImpactedSymbol[];
  containers?: LocalSymbolRef[];
  truncated: boolean;
  seedBasis: SeedBasis;
  partialSeeds?: LocalSymbolRef[];
  hubNodes?: HubNode[];
  routes?: ReachedRoute[];
  cost?: WalkCost;
}

/** A route the engine recognised in the source: a backend handler (`method` + `path`) or a frontend page (`path` only), and the symbol it points at. */
export interface GraphRoute {
  file: string;
  line: number;
  method?: string;
  path: string;
  target?: LocalSymbolRef & { kind: string };
}

/** Who uses one file, read from the index three ways, because each alone can miss a use. Test files are included: telling them apart is the caller's. */
export interface FileImporters {
  file: string;
  /** Whether the index holds the file at all; a file it does not hold has no importers to read, which proves nothing. */
  indexed: boolean;
  /** The files whose code imports the file or a symbol it declares (an alias or a barrel resolved to the declaring file by the engine). */
  importers: string[];
  /** The files with an edge of any kind (call, reference, instantiation, inheritance, re-export) to the file or a symbol it declares: a use needing no import statement, as a same-package class does. */
  users: string[];
  /** The files holding a reference the index could not resolve that names the file or a symbol it declares. */
  namedBy: string[];
  /** False when any list was cut to the reader's bound: they are then lower bounds. */
  complete: boolean;
}

export interface ImportersReport {
  indexedSha: string;
  /** One entry per file asked for, in the order asked; a file past the reader's bound on files is `indexed: false`. */
  files: FileImporters[];
  /** The files that load a module by a name the index cannot resolve (a dynamic import, a require, a reflective load), which may load any file; `complete` false when the list was cut. */
  dynamicLoaders: { files: string[]; complete: boolean };
}
