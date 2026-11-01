import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { ExecPurpose } from "@kernel/exec-purpose.ts";
import type { ExecutionConditions } from "@kernel/execution-conditions.ts";
import type { DevWriteRequest } from "./dev-write-request.ts";
import type { SpecLoadError } from "./spec-load-error.ts";
import type { SkippedTest } from "./skipped-test.ts";
import type { GateDiagnostic } from "./gate-diagnostic.ts";

/** `diagnostics` is present only when the check's report was read into typed problems. */
export interface CheckResult { ok: boolean; output: string; infra?: boolean; diagnostics?: GateDiagnostic[]; }

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  infra: boolean;
  /** Every problem of the checks whose report was read into typed form, warnings included. */
  diagnostics: GateDiagnostic[];
  /** The entries of `errors` that have no typed form. */
  untypedErrors: string[];
}

export interface ExecutionRequest {
  specDir: string;
  baseUrl?: string;
  namespace: string;
  specFiles?: string[];
  /** Attempts after a failure; 0 is a single attempt. Absent: the suite's own config decides. */
  retries?: number;
  /** A title filter, already escaped as a literal. */
  grep?: string;
  /** Have the fixtures count the writes the specs send to DEV; the total comes back as `devWrites`. */
  countWrites?: boolean;
  /** What the execution is for, for the trace. */
  purpose?: ExecPurpose;
  /** When the run signed in the session the execution is given (wall-clock ms). */
  session?: { signedInAt: number };
  coverage?: boolean;
  observe?: boolean;
  /** The seed's mutation fixture input (PW_MUTANT). */
  mutant?: string;
  tests?: readonly string[];
  globalTimeoutMs?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  testIdAttribute?: string;
  project?: string;
  onCase?: (c: { name: string; status: string; detail?: string }) => void;
  onRunning?: (title: string) => void;
  onDiscovered?: (title: string, file?: string) => void;
  changedFiles?: string[];
}

export interface ExecutionResult<Observation = unknown> {
  verdict: RunVerdict;
  cases: QaCase[];
  /** The tests the report says were skipped: no case, but their spec file loaded. Absent: none was skipped. */
  skippedTests?: SkippedTest[];
  logs: string;
  /** Mutating requests to DEV the specs are charged: those the fixtures counted that the control load does not account for. Absent: not counted. */
  devWrites?: number;
  /** How many of the tests behind `devWrites` had not finished when the run ended. Absent: every test finished. */
  unfinishedTests?: number;
  /** The requests behind `devWrites`, by method and origin and pathname. Absent: none recorded. */
  devWriteRequests?: DevWriteRequest[];
  /** The requests the tests' pages sent that the control load of their project also sent, which the spec did not cause and `devWrites` leaves out. Absent: none recorded. */
  controlRequests?: DevWriteRequest[];
  /** What the report says stopped a spec from loading, relative to the spec directory. Present only on a run that executed no test. */
  loadErrors?: SpecLoadError[];
  /** The conditions the execution ran under (shared-kernel/execution-conditions.ts). Absent: the runner did not say. */
  conditions?: ExecutionConditions;
  /** The page each case ended on, when the execution was asked to observe and every observation could be read; its shape is the objective signal's, named by the port. */
  observations?: Observation[];
}
