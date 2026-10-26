import type { Result } from "@kernel/result.ts";
import type { ComplexityHotspot, ExtractorSkipped } from "../../domain/static-signal.ts";
import type { ExtractionContext } from "../../domain/vcs-read.ts";

export interface ComplexityExtractorPort { extract(ctx: ExtractionContext): Promise<Result<ComplexityHotspot[], ExtractorSkipped>>; }
