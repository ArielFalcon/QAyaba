/* Spawn wrapper for untrusted/external binaries: scrubbed env and a process-tree kill on timeout or abort. */

import type { ProcessKillPort } from "../../shared-kernel/process-sandbox/process-kill.port.ts";

export interface SandboxedRunRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SandboxedRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SandboxedBinaryRunner {
  run(req: SandboxedRunRequest): Promise<SandboxedRunResult>;
}

export interface SandboxedBinaryRunnerDeps {
  processKill: ProcessKillPort;
}
