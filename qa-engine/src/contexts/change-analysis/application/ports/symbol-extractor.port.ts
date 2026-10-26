import type { Result } from "@kernel/result.ts";
import type { ChangedSymbol, ExtractorSkipped } from "../../domain/static-signal.ts";
import type { ExtractionContext } from "../../domain/vcs-read.ts";
import type { RelationExtractorPort } from "./relation-extractor.port.ts";
import type { ComplexityExtractorPort } from "./complexity-extractor.port.ts";
import type { SemanticDiffExtractorPort } from "./semantic-diff-extractor.port.ts";
import type { PatternExtractorPort } from "./pattern-extractor.port.ts";

export interface SymbolExtractorPort { extract(ctx: ExtractionContext): Promise<Result<ChangedSymbol[], ExtractorSkipped>>; }

/** All-optional fail-open extractor map. */
export interface ExtractorSet {
  symbols?: SymbolExtractorPort;
  relations?: RelationExtractorPort;
  complexity?: ComplexityExtractorPort;
  semanticDiff?: SemanticDiffExtractorPort;
  patterns?: PatternExtractorPort;
}
