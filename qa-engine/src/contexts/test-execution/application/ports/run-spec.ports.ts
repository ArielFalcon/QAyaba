import type { QaCase } from "@kernel/qa-case.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";

export interface SpecExecutionRequest {
  /* Relative to the spec directory. */
  specFile: string;
  /* A literal title fragment, already escaped for Playwright's --grep. */
  grep?: string;
  namespace: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SpecExecutionResult {
  verdict: RunVerdict;
  cases: readonly QaCase[];
  /* Stays inside the executor's boundary: the use case never forwards it. */
  logs: string;
  /* Mutating requests the executed spec sent to DEV, as the fixtures counted them. Absent: nothing could be counted. */
  devWrites?: number;
}

/* Executes one spec file once, with no retries, in the sandbox, against DEV. */
export interface SpecExecutorPort {
  execute(request: SpecExecutionRequest): Promise<SpecExecutionResult>;
}

/* Removes the test data a namespace left on DEV. Best effort: never throws. */
export interface SpecCleanupPort {
  cleanup(namespace: string, signal?: AbortSignal): Promise<void>;
}

/* Signs in again and refreshes the saved session the next call copies. Resolves whether the session is usable. */
export interface SessionRenewalPort {
  renew(signal?: AbortSignal): Promise<boolean>;
}
