import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { DevWriteRequest } from "./dev-write-request.ts";

export interface CheckResult { ok: boolean; output: string; infra?: boolean; }

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  infra: boolean;
}

export interface ExecutionRequest {
  specDir: string;
  baseUrl?: string;
  namespace: string;
  faultInject?: boolean;
  /* The operations a corrupting re-run may touch, as `{ verb, pattern }`; the pass corrupts nothing when it names none. */
  faultOperations?: ReadonlyArray<{ verb: string; pattern: string }>;
  specFiles?: string[];
  /** Attempts after a failure; 0 is a single attempt. Absent: the suite's own config decides. */
  retries?: number;
  /** A title filter, already escaped as a literal. */
  grep?: string;
  /** Have the fixtures count the writes the specs send to DEV; the total comes back as `devWrites`. */
  countWrites?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  testIdAttribute?: string;
  project?: string;
  onCase?: (c: { name: string; status: string; detail?: string }) => void;
  onRunning?: (title: string) => void;
  onDiscovered?: (title: string, file?: string) => void;
  changedFiles?: string[];
}

export interface ExecutionResult {
  verdict: RunVerdict;
  cases: QaCase[];
  logs: string;
  /** Mutating requests the specs sent to DEV, as the fixtures counted them. Absent: not counted. */
  devWrites?: number;
  /** The requests behind `devWrites`, by method and origin and pathname. Absent: none recorded. */
  devWriteRequests?: DevWriteRequest[];
  /** The requests that keep the run's own session alive, which the fixtures did not count as writes. Absent: none recorded. */
  sessionRequests?: DevWriteRequest[];
}
