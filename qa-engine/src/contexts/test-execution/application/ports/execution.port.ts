import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { ExecutionOpts } from "../../domain/execution.ts";
import type { DevWriteRequest } from "../../domain/dev-write-request.ts";
import type { SpecLoadError } from "../../domain/spec-load-error.ts";
import type { SkippedTest } from "../../domain/skipped-test.ts";
import type { ExecutionConditions } from "@kernel/execution-conditions.ts";
import type { ObservedPage } from "@contexts/objective-signal/application/index.ts";

export interface ExecutionPort {
  /** Bare AbortSignal or richer opts bag; absent is specDir only. */
  execute(specDir: string, opts?: AbortSignal | ExecutionOpts): Promise<{ verdict: RunVerdict; cases: QaCase[]; skippedTests?: SkippedTest[]; logs: string; devWrites?: number; unfinishedTests?: number; devWriteRequests?: DevWriteRequest[]; controlRequests?: DevWriteRequest[]; loadErrors?: SpecLoadError[]; conditions?: ExecutionConditions; observations?: ObservedPage[] }>;
}
