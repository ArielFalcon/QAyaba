import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { DevWriteRequest } from "@contexts/test-execution/application/index.ts";

/** What the loop asks of the run's execution: one spec file of the suite, once, under the namespace the call owns. */
export interface ClosedLoopExecutionPort {
  execute(
    specDir: string,
    opts: { specFiles: string[]; namespace: string; timeoutMs: number; retries: number; countWrites: boolean; grep?: string; signal?: AbortSignal },
  ): Promise<{ verdict: RunVerdict; cases: QaCase[]; logs: string; devWrites?: number; devWriteRequests?: DevWriteRequest[] }>;
}
