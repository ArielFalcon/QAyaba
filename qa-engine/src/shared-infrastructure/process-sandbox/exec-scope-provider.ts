/* Opens a run's sandbox scope: its work directory (made for the sandbox uid, removed when the run ends) and the policy its children run under. One provider per composition; one session per run. */

import { join } from "node:path";
import { newSandboxReport, withExecScope, type ExecScopePort, type RunScope } from "./exec-scope.ts";
import { openRunWorkDir, removeRunWorkDir } from "./exec-workdir.ts";
import type { Sandbox } from "./sandbox.ts";

export interface ExecScopeProviderDeps {
  /* Where the per-run work directories live (`/tmp/qa-exec`). */
  workRoot: string;
  sandbox: Sandbox | null;
  /* The orchestrator-only auth directory of the app; copies of its contents are staged per spawn. */
  authDir?: string;
  gateCreds?: { user: string; pass: string };
  egress: { dev: readonly string[]; install: readonly string[] };
}

export function createExecScopeProvider(deps: ExecScopeProviderDeps): ExecScopePort {
  return {
    open({ runId }) {
      const workDir = openRunWorkDir(deps.workRoot, runId, deps.sandbox);
      const scope: RunScope = {
        runId,
        workDir,
        ...(deps.authDir ? { authDir: deps.authDir } : {}),
        ...(deps.gateCreds ? { gateCreds: deps.gateCreds } : {}),
        egress: deps.egress,
        report: newSandboxReport(),
      };
      return {
        run: (fn) => withExecScope(scope, fn),
        close: () => removeRunWorkDir(workDir),
      };
    },
  };
}

export function defaultWorkRoot(tmp: string): string {
  return join(tmp, "qa-exec");
}
