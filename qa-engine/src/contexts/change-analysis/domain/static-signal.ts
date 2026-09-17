import type { Sha } from "@kernel/sha.ts";
import type { LanguageId } from "./language-id.ts";

export interface ChangedSymbol { file: string; name: string; kind: string; signature: string; line: number; }
export interface RelationEdge { from: string; to: string; via: string; }
/** Optional: lizard cannot produce cognitive complexity (ADR-5). */
export interface ComplexityHotspot { file: string; function: string; ccn: number; cognitive?: number; nloc: number; line: number; }
export interface FileChangeKind { file: string; cosmetic: boolean; }
export interface ChangePattern { file: string; pattern: string; source: "ast-grep" | "regex"; }

/** Typed skip. A consumer routes by `extractor`; a skip never blocks publish. */
export interface ExtractorSkipped { extractor: string; reason: string; }

/** Sha-keyed read-model — no guarded state transitions. */
export interface StaticSignal {
  builtForSha: string;
  languages: LanguageId[];
  symbols: ChangedSymbol[];
  relations: RelationEdge[];
  complexity: ComplexityHotspot[];
  fileChangeKinds: FileChangeKind[];
  patterns: ChangePattern[];
  skipped: ExtractorSkipped[];
}

export function emptyStaticSignal(sha: Sha): StaticSignal {
  return {
    builtForSha: sha.value, languages: [], symbols: [], relations: [],
    complexity: [], fileChangeKinds: [], patterns: [], skipped: [],
  };
}
