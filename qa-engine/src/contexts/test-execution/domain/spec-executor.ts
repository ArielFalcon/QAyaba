import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { DevWriteRequest } from "./dev-write-request.ts";

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
  /* The requests behind that count, by method and origin and pathname. Absent: none recorded. */
  devWriteRequests?: readonly DevWriteRequest[];
  /* The requests that keep the run's own session alive, which the fixtures did not count as writes. Absent: none recorded. */
  sessionRequests?: readonly DevWriteRequest[];
}
