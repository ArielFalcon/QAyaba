
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { QaCase } from "@kernel/qa-case.ts";

export type { DeployGatePort } from "@kernel/ports/deploy-gate.port.ts";

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
}

export interface ExecutionStrategyPort {
  run(req: ExecutionRequest): Promise<ExecutionResult>;
}

export interface CodeValidatePort {
  validate(specDir: string, changedFiles?: string[]): Promise<ValidationResult>;
}
export interface StaticGatePort {
  typecheck(specDir: string): Promise<CheckResult>;
  lint(specDir: string): Promise<CheckResult>;
  listTests(specDir: string): Promise<CheckResult>;
  checkManifest(specDir: string): Promise<CheckResult>;
  validateAll(specDir: string): Promise<ValidationResult>;
}
