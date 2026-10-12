/* The one launcher for every child process that runs code an agent influenced: a spec, a login script, the e2e project's own tsc/eslint/`playwright --list`, its package.json lifecycle scripts, the watched repo's own test command. It exists so that the isolation is decided in one place and cannot be forgotten at a spawn site: the child runs as the sandbox uid, with an environment built from the allowlist of its profile (exec-env.ts), in a per-run work directory, and — when the egress layer is wired — holds a lease on the origins its profile may reach for as long as it lives.
   QA_EXEC_SANDBOX decides what a missing sandbox uid means: `required` refuses to spawn (the run ends E-SANDBOX), `best-effort` runs as the current user and says so loudly, which is what a developer's laptop without the uid needs. The default is best-effort so that `npm run qa` on a host works; the compose file sets required.
   Nothing here reads process.env: the composition root passes the environment in. */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { buildExecEnv, type SandboxProfile } from "./exec-env.ts";
import { activeExecScope, type RunScope } from "./exec-scope.ts";
import { mirrorTopDir, openMirrorForSandbox, type MirrorFsOps } from "./mirror-access.ts";
import { allocWorkSubdir, prepareWritableDirs, stageAuthMaterial, writeWorkScript } from "./exec-workdir.ts";
import { sandboxSpawnOptions, type Sandbox } from "./sandbox.ts";

export type ExecSandboxMode = "required" | "best-effort";

/* The reason a run cannot execute agent code safely. A run that hits it ends as an infra-error E-SANDBOX: persisted, never learned from, no Issue. */
export class SandboxUnavailableError extends Error {
  readonly code = "E-SANDBOX";
  constructor(readonly reason: "uid" | "egress" | "scope", message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export function isSandboxUnavailable(err: unknown): err is SandboxUnavailableError {
  return err instanceof SandboxUnavailableError;
}

export function resolveExecSandboxMode(env: NodeJS.ProcessEnv): ExecSandboxMode {
  const raw = env.QA_EXEC_SANDBOX;
  if (raw === undefined || raw === "") return "best-effort";
  if (raw === "required" || raw === "best-effort") return raw;
  throw new Error(`QA_EXEC_SANDBOX must be "required" or "best-effort", got ${JSON.stringify(raw)}`);
}

/* A held right to reach some origins; released when the child is gone. */
export interface EgressLease {
  release(): void;
}

/* The egress filter as the launcher sees it. */
export interface EgressGate {
  /* "enforce": a missing filter ends the run. "warn": the child runs unfiltered and the run says so. */
  readonly mode: "enforce" | "warn";
  /* Whether the kernel filter and the proxy are up. */
  available(): boolean;
  lease(origins: readonly string[]): EgressLease;
}

export interface ExecSpawnOptions {
  cwd: string;
  profile: SandboxProfile;
  /* The account, honored by the login profile alone. */
  account?: { user: string; pass: string };
  extraEnv?: Record<string, string>;
  stdio?: SpawnOptions["stdio"];
  /* Defaults to the scope of the run the call is part of. */
  scope?: RunScope;
}

export interface ExecSandboxPort {
  spawn(cmd: string, args: readonly string[], options: ExecSpawnOptions): ChildProcess;
  /* Whether children run as the sandbox uid (false: best-effort without it). */
  readonly isolated: boolean;
  /* The work dir of the run the call is part of. The strict readers are rooted here, so that a link planted on the way to a result is refused. */
  workDir(scope?: RunScope): string;
  /* A fresh directory inside the run's work dir for one call, with the named subdirectories, owned by the sandbox. */
  allocDir(prefix: string, subdirs?: readonly string[], scope?: RunScope): string;
  /* Hands directories inside the mirror to the sandbox for writing, and nothing else. */
  prepareWritable(dirs: readonly string[]): void;
  /* Writes a script the orchestrator authored into the run's work dir, readable and not writable by the sandbox, and returns its path. */
  writeScript(name: string, content: string): string;
}

export interface ExecSandboxDeps {
  sandbox: Sandbox | null;
  mode: ExecSandboxMode;
  /* The orchestrator's environment, the base the profiles allowlist from. */
  baseEnv: NodeJS.ProcessEnv;
  egress?: EgressGate;
  /* The mirrors volume: a child whose cwd is in one of its mirrors gets that mirror's group opened to the sandbox for the run (mirror-access.ts). */
  mirrorRoot?: string;
  mirrorOps?: MirrorFsOps;
  /* The spawn primitive; a test passes a fake. */
  spawnFn?: typeof nodeSpawn;
  warn?: (line: string) => void;
}

export function createExecSandbox(deps: ExecSandboxDeps): ExecSandboxPort {
  const spawnFn = deps.spawnFn ?? nodeSpawn;
  const warn = deps.warn ?? ((line: string): void => console.warn(line));
  let warnedNoUid = false;
  let warnedNoEgress = false;

  const originsFor = (profile: SandboxProfile, scope: RunScope): readonly string[] =>
    profile === "offline" ? [] : profile === "install" ? scope.egress.install : scope.egress.dev;

  return {
    isolated: deps.sandbox !== null,
    workDir(scope) {
      const active = scope ?? activeExecScope();
      if (!active) throw new SandboxUnavailableError("scope", "no run scope is active, so there is no work directory");
      return active.workDir;
    },
    allocDir(prefix, subdirs = [], scope) {
      const active = scope ?? activeExecScope();
      if (!active) throw new SandboxUnavailableError("scope", "no run scope is active, so there is no work directory to allocate in");
      return allocWorkSubdir(active.workDir, prefix, subdirs, deps.sandbox);
    },
    prepareWritable(dirs) {
      prepareWritableDirs(dirs, deps.sandbox);
    },
    writeScript(name, content) {
      const active = activeExecScope();
      if (!active) throw new SandboxUnavailableError("scope", "no run scope is active, so there is no work directory for a script");
      return writeWorkScript(active.workDir, name, content);
    },
    spawn(cmd, args, options) {
      const scope = options.scope ?? activeExecScope();
      if (!scope) throw new SandboxUnavailableError("scope", `refusing to spawn ${cmd}: no run scope is active, so there is no work directory or policy for it`);
      if (deps.sandbox === null) {
        if (deps.mode === "required") {
          scope.report.refusal = "uid";
          throw new SandboxUnavailableError("uid", `refusing to spawn ${cmd}: QA_EXEC_SANDBOX=required but no sandbox uid is available (not root on Linux, the image lacks the sandbox user, or CODE_SANDBOX=off)`);
        }
        if (!warnedNoUid) {
          warnedNoUid = true;
          warn("[qa] WARNING: QA_EXEC_SANDBOX=best-effort and no sandbox uid is available: agent-influenced code runs as the orchestrator's own user, with its files and credentials in reach. Do not run this way against anything you care about.");
        }
      }

      let lease: EgressLease | undefined;
      if (deps.egress) {
        if (!deps.egress.available()) {
          if (deps.egress.mode === "enforce") {
            scope.report.refusal = "egress";
            throw new SandboxUnavailableError("egress", `refusing to spawn ${cmd}: QA_EGRESS_MODE=enforce but the egress filter is not active (see the startup self-test)`);
          }
          if (!warnedNoEgress) {
            warnedNoEgress = true;
            warn("[qa] WARNING: QA_EGRESS_MODE=warn and the egress filter is not active: agent-influenced code can reach any host this container can.");
          }
          scope.report.egress = "unenforced";
        } else {
          lease = deps.egress.lease(originsFor(options.profile, scope));
          if (scope.report.egress !== "unenforced") scope.report.egress = "enforced";
        }
      } else if (scope.report.egress === "not-applicable") {
        scope.report.egress = "unenforced";
      }

      if (deps.mirrorRoot && deps.sandbox) {
        const top = mirrorTopDir(deps.mirrorRoot, options.cwd);
        const opened = (scope.openedMirrors ??= new Set<string>());
        if (top !== undefined && !opened.has(top) && openMirrorForSandbox(top, deps.sandbox, deps.mirrorOps)) opened.add(top);
      }

      const staged = options.profile === "suite" || options.profile === "login" ? stageAuthMaterial(scope.authDir, scope.workDir, deps.sandbox) : {};
      const env = buildExecEnv({
        profile: options.profile,
        base: deps.baseEnv,
        sandbox: deps.sandbox,
        workDir: scope.workDir,
        ...(scope.gateCreds ? { gateCreds: scope.gateCreds } : {}),
        staged,
        ...(options.account ? { account: options.account } : {}),
        ...(options.extraEnv ? { extraEnv: options.extraEnv } : {}),
      });
      const ids = sandboxSpawnOptions({}, deps.sandbox);
      let child: ChildProcess;
      try {
        child = spawnFn(cmd, [...args], {
          cwd: options.cwd,
          env,
          detached: true,
          ...(options.stdio !== undefined ? { stdio: options.stdio } : {}),
          ...(ids.uid !== undefined ? { uid: ids.uid, gid: ids.gid } : {}),
        });
      } catch (err) {
        lease?.release();
        throw err;
      }
      if (lease) {
        const held = lease;
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          held.release();
        };
        child.once("close", release);
        child.once("error", release);
      }
      return child;
    },
  };
}
