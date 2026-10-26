import type { Result } from "@kernel/result.ts";
import type { RelationEdge, ExtractorSkipped } from "../../domain/static-signal.ts";
import type { ExtractionContext } from "../../domain/vcs-read.ts";

export interface RelationExtractorPort { extract(ctx: ExtractionContext): Promise<Result<RelationEdge[], ExtractorSkipped>>; }
