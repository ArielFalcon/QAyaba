/* Opens a run's sandbox scope: its work directory (made for the sandbox uid, removed when the run ends) and the policy its children run under. One provider per composition; one session per run. */

import { join } from "node:path";
import { activeRunSecretScope } from "../redaction/run-secret-redaction.ts";
import { newSandboxReport, withExecScope, type ExecScopePort, type RunScope } from "./exec-scope.ts";
import { SandboxUnavailableError, type EgressGate } from "./exec-sandbox.ts";
import { openRunWorkDir, removeRunWorkDir } from "./exec-workdir.ts";
import { closeMirror, sealMirrors, type MirrorFsOps } from "./mirror-access.ts";
import { SandboxResidueError, type SandboxReaper } from "./sandbox-reaper.ts";
import type { Sandbox } from "./sandbox.ts";

export interface ExecScopeProviderDeps {
  /* Where the per-run work directories live (`/tmp/qa-exec`). */
  workRoot: string;
  sandbox: Sandbox | null;
  /* The orchestrator-only auth directory of the app; copies of its contents are staged per spawn. */
  authDir?: string;
  gateCreds?: { user: string; pass: string };
  /* The account an opted-in app's specs may log in with; registered as a run secret so it is redacted by value wherever it appears. */
  suiteAccount?: { user: string; pass: string };
  egress: { dev: readonly string[]; install: readonly string[] };
  /* The mirrors volume: every mirror is sealed to root alone when a run opens its scope and again when it ends, so none stays open to the sandbox group (and one created since boot is closed). */
  mirrorRoot?: string;
  mirrorOps?: MirrorFsOps;
  /*
   * Whether the scope seals every mirror (a run: none stays open, one created since boot included) or closes only the mirrors its own
   * children were given (a script, which may run beside a live run whose mirror must stay open). Default: every mirror.
   */
  mirrorSeal?: "all" | "own";
  /* The egress filter, prepared for the run's origins before its first child. */
  egressGate?: EgressGate;
  /* Ends every process the sandbox uid still has when the scope opens (an earlier run's) and when it closes (this run's). Absent: nothing is reaped. */
  reaper?: SandboxReaper;
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
      /* Nothing an earlier run left running may be alive when this one starts: it shares the sandbox uid and would see this run's children. A survivor that cannot be killed refuses the run. */
      if (deps.sandbox && deps.reaper) {
        try {
          deps.reaper.reapOrphans();
        } catch (err) {
          if (!(err instanceof SandboxResidueError)) throw err;
          throw new SandboxUnavailableError("residue", `the run cannot start: ${err.message}`);
        }
      }
      await deps.egressGate?.prepare?.([...deps.egress.dev, ...deps.egress.install]);
      if (deps.mirrorSeal !== "own") sealAll();
      const workDir = openRunWorkDir(deps.workRoot, runId, deps.sandbox);
      const scope: RunScope = {
        runId,
        workDir,
        ...(deps.authDir ? { authDir: deps.authDir } : {}),
        ...(deps.gateCreds ? { gateCreds: deps.gateCreds } : {}),
        ...(deps.suiteAccount ? { suiteAccount: deps.suiteAccount } : {}),
        egress: deps.egress,
        report: newSandboxReport(),
      };
      return {
        run: (fn) => withExecScope(scope, () => {
          if (deps.suiteAccount) activeRunSecretScope()?.addAccountSecrets([deps.suiteAccount.pass]);
          return fn();
        }),
        close: () => {
          /* The run's children are done, so what is still running under their uid is theirs to have left: ended before the directory they were writing in goes. A survivor is said loudly; the next scope and the next spawn refuse to go on while it lives. */
          if (deps.sandbox && deps.reaper) {
            try {
              deps.reaper.reapOrphans();
            } catch (err) {
              console.error(`[qa] ERROR: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          removeRunWorkDir(workDir);
          /* The mirrors the run opened to the sandbox's group go back to root alone. */
          if (deps.mirrorSeal !== "own") sealAll();
          else closeOwnMirrors(scope.openedMirrors, deps.mirrorOps);
        },
      };
    },
  };
}

/* Closes the mirrors one scope's children were given, and no other. A fault is said; the next run's scope seals every mirror. */
function closeOwnMirrors(opened: ReadonlySet<string> | undefined, ops: MirrorFsOps | undefined): void {
  for (const dir of opened ?? []) {
    try {
      closeMirror(dir, ops);
    } catch (err) {
      console.warn(`[qa] WARNING: a mirror could not be closed (${err instanceof Error ? err.message : String(err)}); the next run's scope seals it.`);
    }
  }
}

export function defaultWorkRoot(tmp: string): string {
  return join(tmp, "qa-exec");
}
