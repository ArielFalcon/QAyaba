/* Spawn wrapper for untrusted/external binaries: scrubbed env and a process-tree kill on timeout or abort. */

import type { ProcessKillPort } from "../../shared-kernel/process-sandbox/process-kill.port.ts";

export interface SandboxedRunRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /* Keep only the newest this-many chars of each output stream instead of all of it. For a child that runs untrusted code and whose output is diagnostic: it can write without limit and never fails the run for it. Without it the output is returned whole and a child that passes the runner's output bound is killed and rejected. */
  outputKeepChars?: number;
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
  /* Chars of each stream a run without `outputKeepChars` may produce before it is killed and rejected. Defaults to DEFAULT_MAX_OUTPUT_CHARS. */
  maxOutputChars?: number;
}

/* Matches the maxBuffer of the shell's own git spawn: more than this on one stream is never a result a caller can use. */
export const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024 * 1024;
