import type { Result } from "@kernel/result.ts";
import type { FileChangeKind, ExtractorSkipped } from "../../domain/static-signal.ts";
import type { ExtractionContext } from "../../domain/vcs-read.ts";

export interface SemanticDiffExtractorPort { extract(ctx: ExtractionContext): Promise<Result<FileChangeKind[], ExtractorSkipped>>; }
