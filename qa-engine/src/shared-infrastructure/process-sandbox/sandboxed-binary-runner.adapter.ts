/* Spawns a command, captures stdout/stderr, and kills the whole process tree (injected ProcessKillPort) on timeout or abort. detached:true so the child leads its own process group; negative-pid kill reaps forked grandchildren that a plain child.kill() would orphan. */

import { spawn } from "node:child_process";
import type { SandboxedBinaryRunner, SandboxedBinaryRunnerDeps, SandboxedRunRequest, SandboxedRunResult } from "./sandboxed-binary-runner.ts";

export class SandboxedBinaryRunnerAdapter implements SandboxedBinaryRunner {
  constructor(private readonly deps: SandboxedBinaryRunnerDeps) {}

  run(req: SandboxedRunRequest): Promise<SandboxedRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(req.command, [...req.args], {
        cwd: req.cwd,
        env: req.env,
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (onAbort) req.signal?.removeEventListener("abort", onAbort);
        fn();
      };

      /* Timeout guard: a hung binary must never hold the caller forever. Kill the whole process tree and resolve timedOut:true — never rejects on a timeout (a wedged process is a result, not a thrown error, matching SandboxedRunResult's contract). */
      const timer = req.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            this.deps.processKill.killTree(child);
            settle(() => resolve({ exitCode: null, stdout, stderr, timedOut }));
          }, req.timeoutMs)
        : undefined;

      const onAbort = req.signal
        ? (): void => {
            timedOut = true;
            this.deps.processKill.killTree(child);
            settle(() => resolve({ exitCode: null, stdout, stderr, timedOut }));
          }
        : undefined;
      if (onAbort) req.signal!.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (d: Buffer | string) => (stdout += String(d)));
      child.stderr?.on("data", (d: Buffer | string) => (stderr += String(d)));
      child.on("error", (err) => settle(() => reject(err)));
      child.on("close", (code) => settle(() => resolve({ exitCode: code, stdout, stderr, timedOut })));
    });
  }
}
