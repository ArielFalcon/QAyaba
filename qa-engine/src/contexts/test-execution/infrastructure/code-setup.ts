/* Code-mode setup: install the watched repo's dependencies under the injected sandbox. Never reads process.env. */

import { spawn } from "node:child_process";
import type { ProcessKillPort } from "@kernel/process-sandbox/process-kill.port.ts";
import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";
import { BoundedOutputTail } from "@kernel/process-sandbox/bounded-output-tail.ts";
import { ProcessKillAdapter } from "../../../shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import { sandboxSpawnOptions, prepareSandboxWorkdir, type Sandbox } from "../../../shared-infrastructure/process-sandbox/sandbox.ts";
import { detectCodeProject, DEFAULT_CODE_MODE_TIMEOUT_MS, type CodeProject } from "./code-execution.runner.ts";

/* Bound on the install-failure output folded into the thrown error: enough to carry the real
   npm/pip/.../error, never enough to blow up an Issue/log line with a full dependency-tree dump. */
export const INSTALL_FAILURE_LOG_TAIL_CHARS = 4000;

/* What is kept of each stream while the install runs. Twice the reported tail, so a secret straddling the cut of the reported tail is still whole when it is redacted, and an install that writes without limit cannot grow the orchestrator's memory. */
export const INSTALL_OUTPUT_KEEP_CHARS = INSTALL_FAILURE_LOG_TAIL_CHARS * 2;

/* The outer timeout is only the backstop for a `deps.install` that never settles on its own; the real install times out first, with the child's output attached. */
const INSTALL_TIMEOUT_BACKSTOP_GRACE_MS = 1000;

/* setTimeout treats a delay above 2^31-1 ms as 1 ms, which would fire the backstop at once. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

function tail(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : `…[${s.length - maxChars} chars omitted]…\n${s.slice(-maxChars)}`;
}

export interface CodeSetupDeps {
  detect(repoDir: string): CodeProject;
  install(project: CodeProject, repoDir: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  /* Hands the working copy to the unprivileged sandbox user BEFORE any untrusted spawn. Runs for every code-mode run — including the null-install ecosystems (Maven/Gradle/Rust) whose first untrusted spawn is the test itself — so it must execute before the install-null early return. */
  prepareWorkdir?(repoDir: string): void;
}

export async function setupCodeProject(
  repoDir: string,
  deps: CodeSetupDeps,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  const project = deps.detect(repoDir);
  deps.prepareWorkdir?.(repoDir); /* drop the working copy to the sandbox user before any spawn */
  if (!project.install) return;
  if (opts?.signal?.aborted) throw new Error("code-mode install aborted by operator cancel");

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_CODE_MODE_TIMEOUT_MS;
  const backstopMs = Math.min(timeoutMs + INSTALL_TIMEOUT_BACKSTOP_GRACE_MS, MAX_TIMER_DELAY_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`code-mode install timeout after ${backstopMs}ms`)), backstopMs);
  });
  try {
    await Promise.race([deps.install(project, repoDir, opts), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

/** The REAL, spawning CodeSetupDeps — a FACTORY (not a plain constant), matching createDefaultCodeExecuteDeps's own sandbox-injection pattern (code-execution.runner.ts's header explains why `resolveSandbox()` cannot be called internally here). */
export function createDefaultCodeSetupDeps(
  sandbox: Sandbox | null,
  processKill: ProcessKillPort = new ProcessKillAdapter(),
): CodeSetupDeps {
  return {
    detect: (repoDir) => detectCodeProject(repoDir),
    prepareWorkdir: (repoDir) => prepareSandboxWorkdir(repoDir, sandbox),
    install: (project, repoDir, opts) =>
      new Promise((resolve, reject) => {
        const { cmd, args } = project.install!;
        const child = spawn(cmd, args, { cwd: repoDir, detached: true, ...sandboxSpawnOptions(scrubEnv(), sandbox) });
        /* Drain both pipes as they arrive: an install that writes more than the OS pipe buffer
           (npm's own verbose/warning output easily does) would otherwise block the child on
           write() forever if nobody reads — a stall, not just a discarded log. Only a bounded
           tail is kept: the child is untrusted and may write without limit. */
        const stdout = new BoundedOutputTail(INSTALL_OUTPUT_KEEP_CHARS);
        const stderr = new BoundedOutputTail(INSTALL_OUTPUT_KEEP_CHARS);
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (d: string) => stdout.append(d));
        child.stderr?.on("data", (d: string) => stderr.append(d));
        /* The child's output as it leaves the process boundary: redacted (same redaction as text leaving the system elsewhere in qa-engine) BEFORE it is cut to the reported tail, so a secret straddling the cut cannot survive as a fragment. */
        const outputDetail = (): string => {
          const redacted = sanitizeText(`${stdout.text()}${stderr.text()}`.trim()).text;
          const shown = tail(redacted, INSTALL_FAILURE_LOG_TAIL_CHARS);
          return shown ? `:\n${shown}` : "";
        };
        let settled = false;
        const settle = (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          err ? reject(err) : resolve();
        };
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_CODE_MODE_TIMEOUT_MS;
        const timer = setTimeout(() => {
          processKill.killTree(child);
          settle(new Error(`code-mode install timeout after ${timeoutMs}ms${outputDetail()}`));
        }, timeoutMs);
        opts?.signal?.addEventListener("abort", () => {
          processKill.killTree(child);
          settle(new Error("code-mode install aborted by operator cancel"));
        }, { once: true });
        child.on("error", (err) => settle(err instanceof Error ? err : new Error(String(err))));
        child.on("close", (code) => {
          if (code === 0) { settle(); return; }
          /* Surface the real failure loudly instead of just the exit code. */
          settle(new Error(`code-mode install failed (${cmd} ${args.join(" ")}, exit ${code})${outputDetail()}`));
        });
      }),
  };
}
