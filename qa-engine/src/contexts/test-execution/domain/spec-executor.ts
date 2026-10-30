import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { DevWriteRequest } from "./dev-write-request.ts";
import type { SpecLoadError } from "./spec-load-error.ts";

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
  /* Mutating requests to DEV the executed spec is charged: those the fixtures counted that the workers' control loads do not account for. Absent: nothing could be counted. */
  devWrites?: number;
  /* How many of the tests behind that count had not finished when the call ended (it was stopped or the child crashed): each was charged its answered writes plus the requests it still had out. Absent: every test finished. */
  unfinishedTests?: number;
  /* The requests behind that charge, by method and origin and pathname. Absent: none recorded. */
  devWriteRequests?: readonly DevWriteRequest[];
  /* The requests the tests' pages sent that the workers' control loads also sent, which the spec did not cause and the charge leaves out. Absent: none recorded. */
  controlRequests?: readonly DevWriteRequest[];
  /* Why the spec did not load, from the report's top-level errors, with files relative to the spec directory. Absent: the report named none. */
  loadErrors?: readonly SpecLoadError[];
}
