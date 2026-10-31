import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { ExecutionOpts } from "../../domain/execution.ts";
import type { DevWriteRequest } from "../../domain/dev-write-request.ts";
import type { SpecLoadError } from "../../domain/spec-load-error.ts";
import type { SkippedTest } from "../../domain/skipped-test.ts";
import type { ExecutionConditions } from "@kernel/execution-conditions.ts";
import type { ObservedPage } from "@contexts/objective-signal/application/index.ts";

/** Why the run's own port says an execution's result judges nothing: `session-lost`, a signal execution (a mutant's re-run) met a session the app had ended and that the run could not bring back for it. */
export type NotJudgedReason = "session-lost";

export interface ExecutionPort {
  /** Bare AbortSignal or richer opts bag; absent is specDir only. `notJudged` is set only by the run's own port, on a result no reader may judge. */
  execute(specDir: string, opts?: AbortSignal | ExecutionOpts): Promise<{ verdict: RunVerdict; cases: QaCase[]; skippedTests?: SkippedTest[]; logs: string; devWrites?: number; unfinishedTests?: number; devWriteRequests?: DevWriteRequest[]; controlRequests?: DevWriteRequest[]; loadErrors?: SpecLoadError[]; conditions?: ExecutionConditions; observations?: ObservedPage[]; notJudged?: NotJudgedReason }>;
}
