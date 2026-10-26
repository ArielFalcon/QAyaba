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

/**
 * A symbol the graph reached from a change: depth 0 is a changed symbol itself; `via` is the symbol one hop closer to the change.
 * `confidence` is the lowest confidence of an edge on the path that first reached it (1 for a changed symbol or an edge that
 * states none): evidence for a consumer to weigh, never a filter. `range` is the line span of a changed symbol (depth 0 only).
 */
export interface ImpactedSymbol extends LocalSymbolRef {
  kind: string;
  depth: number;
  confidence: number;
  range?: { start: number; end: number };
  via?: LocalSymbolRef;
}

/** Where a walk's seeds came from: the symbols holding the touched lines, every symbol of the changed files (the diff was not read), or no symbol at all. */
export type SeedBasis = "lines" | "whole-file" | "none";

/** What a walk is allowed to spend: how many hops, and how many symbols in all. */
export interface ImpactBudget {
  depth: number;
  maxSymbols: number;
}

/** A walk's answer, ordered by (depth, file, line, symbol). `truncated` says the budget cut it. `indexedSha` is the commit of the index it read. `seedBasis` says what the depth-0 symbols stand for. */
export interface ImpactReport {
  indexedSha: string;
  symbols: ImpactedSymbol[];
  truncated: boolean;
  seedBasis: SeedBasis;
}

/** A route the engine recognised in the source: a backend handler (`method` + `path`) or a frontend page (`path` only), and the symbol it points at. */
export interface GraphRoute {
  file: string;
  line: number;
  method?: string;
  path: string;
  target?: LocalSymbolRef & { kind: string };
}
