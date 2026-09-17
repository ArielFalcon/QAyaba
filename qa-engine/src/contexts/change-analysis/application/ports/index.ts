/* Deterministic blast-radius ports. VcsReadPort is the typed read side (no raw git argv). Extractor ports are all-optional fail-open: each returns ExtractorSkipped on degrade, never throws past the use-case. Change VOs live in static-signal.ts. */
import type { Sha } from "@kernel/sha.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { Result } from "@kernel/result.ts";
import type {
  ChangedSymbol, RelationEdge, ComplexityHotspot, FileChangeKind, ChangePattern, ExtractorSkipped,
} from "../../domain/static-signal.ts";

export type { ExtractorSkipped };

/** Typed read over a git mirror. The adapter owns argv; callers see Sha + typed results only. */
export interface VcsReadPort {
  diff(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<string>;
  message(sha: Sha): Promise<string>;
  blastRadius(sha: Sha, opts?: { baseSha?: Sha; commits?: number }): Promise<BlastRadius>;
  /**
   * Other commits' messages in the full reachable `baseSha..sha` range (both merge parents), excluding `sha` itself (head comes from message(sha)). Order unspecified. [] when baseSha is absent or equals sha. Optional: omitting it is the single-commit path.
   */
  otherMessages?(sha: Sha, opts: { baseSha: Sha }): Promise<string[]>;
}

export interface ExtractionContext {
  sha: Sha;
  baseSha?: Sha;
  repoDir: string;
  changedFiles: string[];
  diff: string;
}

export interface SymbolExtractorPort { extract(ctx: ExtractionContext): Promise<Result<ChangedSymbol[], ExtractorSkipped>>; }
export interface RelationExtractorPort { extract(ctx: ExtractionContext): Promise<Result<RelationEdge[], ExtractorSkipped>>; }
export interface ComplexityExtractorPort { extract(ctx: ExtractionContext): Promise<Result<ComplexityHotspot[], ExtractorSkipped>>; }
export interface SemanticDiffExtractorPort { extract(ctx: ExtractionContext): Promise<Result<FileChangeKind[], ExtractorSkipped>>; }
export interface PatternExtractorPort { extract(ctx: ExtractionContext): Promise<Result<ChangePattern[], ExtractorSkipped>>; }

/** All-optional fail-open extractor map. */
export interface ExtractorSet {
  symbols?: SymbolExtractorPort;
  relations?: RelationExtractorPort;
  complexity?: ComplexityExtractorPort;
  semanticDiff?: SemanticDiffExtractorPort;
  patterns?: PatternExtractorPort;
}
