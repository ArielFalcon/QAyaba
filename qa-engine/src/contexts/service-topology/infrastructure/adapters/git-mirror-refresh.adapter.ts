/* MirrorRefreshPort over the sandboxed binary runner: a hardened `git fetch` with a scrubbed environment. The exit code and the timeout are unread, so a failed fetch falls through with the mirror as it is. */

import { hardenGitArgs } from "../../../../shared-infrastructure/process-sandbox/git-hardening.ts";
import type { SandboxedBinaryRunner } from "../../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { scrubEnv } from "../../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import type { MirrorRefreshPort } from "../../application/ports/mirror-refresh.port.ts";

const FETCH_TIMEOUT_MS = 30_000;

export class GitMirrorRefreshAdapter implements MirrorRefreshPort {
  constructor(private readonly runner: SandboxedBinaryRunner) {}

  async refresh(mirrorDir: string): Promise<void> {
    await this.runner.run({
      command: "git",
      args: hardenGitArgs(["fetch", "--no-recurse-submodules", "origin"], mirrorDir),
      cwd: mirrorDir,
      env: scrubEnv(),
      timeoutMs: FETCH_TIMEOUT_MS,
    });
  }
}
