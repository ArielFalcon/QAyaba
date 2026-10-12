/* Opens a run's sandbox scope: its work directory (made for the sandbox uid, removed when the run ends) and the policy its children run under. One provider per composition; one session per run. */

import { join } from "node:path";
import { newSandboxReport, withExecScope, type ExecScopePort, type RunScope } from "./exec-scope.ts";
import type { EgressGate } from "./exec-sandbox.ts";
import { openRunWorkDir, removeRunWorkDir } from "./exec-workdir.ts";
import { sealMirrors, type MirrorFsOps } from "./mirror-access.ts";
import type { Sandbox } from "./sandbox.ts";

export interface ExecScopeProviderDeps {
  /* Where the per-run work directories live (`/tmp/qa-exec`). */
  workRoot: string;
  sandbox: Sandbox | null;
  /* The orchestrator-only auth directory of the app; copies of its contents are staged per spawn. */
  authDir?: string;
  gateCreds?: { user: string; pass: string };
  egress: { dev: readonly string[]; install: readonly string[] };
  /* The mirrors volume: every mirror is sealed to root alone when a run opens its scope and again when it ends, so none stays open to the sandbox group (and one created since boot is closed). */
  mirrorRoot?: string;
  mirrorOps?: MirrorFsOps;
  /* The egress filter, prepared for the run's origins before its first child. */
  egressGate?: EgressGate;
}

export function createExecScopeProvider(deps: ExecScopeProviderDeps): ExecScopePort {
  const sealAll = (): void => {
    if (!deps.mirrorRoot || !deps.sandbox) return;
    try {
      sealMirrors(deps.mirrorRoot, deps.mirrorOps);
    } catch (err) {
      console.warn(`[qa] WARNING: the mirrors could not be sealed (${err instanceof Error ? err.message : String(err)}); the sandbox uid may reach a mirror it should not until the next boot.`);
    }
  };
  return {
    async open({ runId }) {
      await deps.egressGate?.prepare?.([...deps.egress.dev, ...deps.egress.install]);
      sealAll();
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
        close: () => {
          removeRunWorkDir(workDir);
          /* The mirrors the run opened to the sandbox's group go back to root alone. */
          sealAll();
        },
      };
    },
  };
}

export function defaultWorkRoot(tmp: string): string {
  return join(tmp, "qa-exec");
}
