/* Spawns a command, captures stdout/stderr (all of it up to a bound, or only the newest part on request), and kills the whole process tree (injected ProcessKillPort) on timeout or abort. detached:true so the child leads its own process group; negative-pid kill reaps forked grandchildren that a plain child.kill() would orphan. */

import { spawn } from "node:child_process";
import { BoundedOutputTail } from "../../shared-kernel/process-sandbox/bounded-output-tail.ts";
import { BoundedWholeOutput } from "../../shared-kernel/process-sandbox/bounded-whole-output.ts";
import { DEFAULT_MAX_OUTPUT_CHARS, type SandboxedBinaryRunner, type SandboxedBinaryRunnerDeps, type SandboxedRunRequest, type SandboxedRunResult } from "./sandboxed-binary-runner.ts";

interface OutputCapture {
  append(chunk: string): void;
  text(): string;
  readonly exceeded: boolean;
}

/* The newest output only: never exceeds anything, so it never asks for the child to be killed. */
class NewestOutput implements OutputCapture {
  readonly exceeded = false;
  private readonly tail: BoundedOutputTail;
  constructor(keepChars: number) {
    this.tail = new BoundedOutputTail(keepChars);
  }
  append(chunk: string): void {
    this.tail.append(chunk);
  }
  text(): string {
    return this.tail.text();
  }
}

export class SandboxedBinaryRunnerAdapter implements SandboxedBinaryRunner {
  constructor(private readonly deps: SandboxedBinaryRunnerDeps) {}

  run(req: SandboxedRunRequest): Promise<SandboxedRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(req.command, [...req.args], {
        cwd: req.cwd,
        env: req.env,
        detached: true,
      });

      const maxOutputChars = this.deps.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
      const capture = (): OutputCapture => (req.outputKeepChars === undefined ? new BoundedWholeOutput(maxOutputChars) : new NewestOutput(req.outputKeepChars));
      const stdout = capture();
      const stderr = capture();
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
            settle(() => resolve({ exitCode: null, stdout: stdout.text(), stderr: stderr.text(), timedOut }));
          }, req.timeoutMs)
        : undefined;

      const onAbort = req.signal
        ? (): void => {
            timedOut = true;
            this.deps.processKill.killTree(child);
            settle(() => resolve({ exitCode: null, stdout: stdout.text(), stderr: stderr.text(), timedOut }));
          }
        : undefined;
      if (onAbort) req.signal!.addEventListener("abort", onAbort, { once: true });

      /* A run that passes the output bound is killed and rejected: a caller that parses the output would otherwise parse a truncated document. */
      const failOnOverflow = (name: string, output: OutputCapture): void => {
        if (!output.exceeded || settled) return;
        this.deps.processKill.killTree(child);
        settle(() => reject(new Error(`${req.command} wrote more than ${maxOutputChars} chars to ${name}; killed`)));
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => { stdout.append(d); failOnOverflow("stdout", stdout); });
      child.stderr?.on("data", (d: string) => { stderr.append(d); failOnOverflow("stderr", stderr); });
      child.on("error", (err) => settle(() => reject(err)));
      child.on("close", (code) => settle(() => resolve({ exitCode: code, stdout: stdout.text(), stderr: stderr.text(), timedOut })));
    });
  }
}
