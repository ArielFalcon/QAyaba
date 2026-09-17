/* Intra-repo structural VOs spoken by CodeGraphPort. LocalSymbolRef is intra-repo and is distinct from service-topology's ServiceSymbolRef (cross-repo, carries a repo identity). Never name a transport or a watched-app literal here. */

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

/** Existing spec/test coverage referencing a changed symbol. coveredSymbol is optional: a spec may be known to cover the change without the graph resolving the exact intra-repo symbol it hit. */
export interface SpecCoverage {
  specFile: string;
  testName: string;
  coveredSymbol?: LocalSymbolRef;
}

/** Typed failure: the graph is unavailable for a query (not indexed, MCP unreachable). Query methods fail-open — a consumer treats this as "no structural signal", never as a hard error. */
export interface CodeGraphUnavailable {
  reason: string;
}

/** Typed failure: syncTo could not build the whole index (empty index / crashed indexer). Never used for per-file absence — that surfaces later as ExtractorSkipped at extract() time. */
export interface IndexFailed {
  reason: string;
}
