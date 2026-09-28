/* Code-mode setup: install the watched repo's dependencies under the injected sandbox. Never reads process.env. */

import { spawn } from "node:child_process";
import type { ProcessKillPort } from "@kernel/process-sandbox/process-kill.port.ts";
import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";
import { ProcessKillAdapter } from "../../../shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import { sandboxSpawnOptions, prepareSandboxWorkdir, type Sandbox } from "../../../shared-infrastructure/process-sandbox/sandbox.ts";
import { detectCodeProject, DEFAULT_CODE_MODE_TIMEOUT_MS, type CodeProject } from "./code-execution.runner.ts";

/* Bound on the install-failure output folded into the thrown error: enough to carry the real
   npm/pip/.../error, never enough to blow up an Issue/log line with a full dependency-tree dump. */
const INSTALL_FAILURE_LOG_TAIL_CHARS = 4000;

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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`code-mode install timeout after ${timeoutMs}ms`)), timeoutMs);
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
           write() forever if nobody reads — a stall, not just a discarded log. */
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d) => { stdout += d; });
        child.stderr?.on("data", (d) => { stderr += d; });
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
          settle(new Error(`code-mode install timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        opts?.signal?.addEventListener("abort", () => {
          processKill.killTree(child);
          settle(new Error("code-mode install aborted by operator cancel"));
        }, { once: true });
        child.on("error", (err) => settle(err instanceof Error ? err : new Error(String(err))));
        child.on("close", (code) => {
          if (code === 0) { settle(); return; }
          /* Surface the real failure loudly instead of just the exit code — sanitized (this
             leaves the process boundary, same redaction as text leaving the system elsewhere in
             qa-engine) and bounded (never dump an unbounded dependency-tree log into an error). */
          const sanitized = sanitizeText(tail(`${stdout}${stderr}`.trim(), INSTALL_FAILURE_LOG_TAIL_CHARS)).text;
          const detail = sanitized ? `:\n${sanitized}` : "";
          settle(new Error(`code-mode install failed (${cmd} ${args.join(" ")}, exit ${code})${detail}`));
        });
      }),
  };
}
