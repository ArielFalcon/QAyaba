import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { ExecutionOpts } from "../../domain/execution.ts";

export interface ExecutionPort {
  /** Bare AbortSignal or richer opts bag; absent is specDir only. */
  execute(specDir: string, opts?: AbortSignal | ExecutionOpts): Promise<{ verdict: RunVerdict; cases: QaCase[]; logs: string; devWrites?: number }>;
}
