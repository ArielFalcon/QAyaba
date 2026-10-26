import type { Result } from "@kernel/result.ts";
import type { ChangePattern, ExtractorSkipped } from "../../domain/static-signal.ts";
import type { ExtractionContext } from "../../domain/vcs-read.ts";

export interface PatternExtractorPort { extract(ctx: ExtractionContext): Promise<Result<ChangePattern[], ExtractorSkipped>>; }
