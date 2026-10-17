/* The one launcher for every child process that runs code an agent influenced: a spec, a login script, the e2e project's own tsc/eslint/`playwright --list`, its package.json lifecycle scripts, the watched repo's own test command. It exists so that the isolation is decided in one place and cannot be forgotten at a spawn site: the child runs as the sandbox uid, with an environment built from the allowlist of its profile (exec-env.ts), in a per-run work directory, and — when the egress layer is wired — holds a lease on the origins its profile may reach for as long as it lives.
   QA_EXEC_SANDBOX decides what a missing sandbox uid means: `required` refuses to spawn (the run ends E-SANDBOX), `best-effort` runs as the current user and says so loudly, which is what a developer's laptop without the uid needs. The default is best-effort so that `npm run qa` on a host works; the compose file sets required.
   Nothing here reads process.env: the composition root passes the environment in. */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { buildExecEnv, type SandboxProfile } from "./exec-env.ts";
import { activeExecScope, openDeniedWindow, type RunScope, type SandboxReport } from "./exec-scope.ts";
import { guardTelemetry } from "../../shared-kernel/telemetry/guarded-telemetry.ts";
import type { SpanHandle, TelemetryPort } from "../../shared-kernel/telemetry/telemetry.port.ts";
import { activeRunSecretScope } from "../run-secret-redaction.ts";
import { mirrorTopDir, openMirrorForSandbox, type MirrorFsOps } from "./mirror-access.ts";
import { allocWorkSubdir, stageAuthMaterial, writeWorkScript } from "./exec-workdir.ts";
import { sandboxSpawnOptions, type Sandbox } from "./sandbox.ts";
import { SandboxResidueError, liveSandboxChildren, trackSandboxChild, type SandboxReaper } from "./sandbox-reaper.ts";

const EXIT_GRACE_MS = 2000;

export type ExecSandboxMode = "required" | "best-effort";

/* The reason a run cannot execute agent code safely. A run that hits it ends as an infra-error E-SANDBOX: persisted, never learned from, no Issue. */
export class SandboxUnavailableError extends Error {
  readonly code = "E-SANDBOX";
  constructor(readonly reason: "uid" | "files" | "egress" | "scope" | "residue", message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export function isSandboxUnavailable(err: unknown): err is SandboxUnavailableError {
  return err instanceof SandboxUnavailableError;
}

/* Said once per process, not per launcher: a composition builds several. */
let warnedNoUid = false;
let warnedNoEgress = false;
let warnedFileBoundary = false;

/* For tests: the warnings are said again. */
export function resetExecSandboxWarnings(): void {
  warnedNoUid = false;
  warnedNoEgress = false;
  warnedFileBoundary = false;
}

/* Unset means `required` wherever the sandbox uid can exist (root on Linux, which is every container): a deployment that forgot the variable must refuse to run agent code as the orchestrator, not run it with a warning. Elsewhere (a developer's laptop, or a non-root user) there is no uid to drop to and the default is best-effort. An explicit value is always the operator's. */
export function resolveExecSandboxMode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, getuid: () => number = () => process.getuid?.() ?? -1): ExecSandboxMode {
  const raw = env.QA_EXEC_SANDBOX;
  if (raw === undefined || raw === "") return platform === "linux" && getuid() === 0 ? "required" : "best-effort";
  if (raw === "required" || raw === "best-effort") return raw;
  throw new Error(`QA_EXEC_SANDBOX must be "required" or "best-effort", got ${JSON.stringify(raw)}`);
}

/* The file boundary as the boot check found it (src/server/file-boundary-check.ts): whether the sandbox uid really cannot read the orchestrator's secrets or write its code and config on this host's filesystems. A permission that a filesystem does not enforce (a bind mount of Docker Desktop's file sharing) is only proven by trying, as that uid. */
export interface FileBoundaryGate {
  /* What the sandbox uid can reach that it must not, in words; undefined when the boundary holds. */
  breach(): string | undefined;
}

/* A held right to reach some origins; released when the child is gone. */
export interface EgressLease {
  release(): void;
}

/* The egress filter as the launcher sees it. */
export interface EgressGate {
  /* "enforce": a missing filter ends the run. "warn": the child runs unfiltered and the run says so. */
  readonly mode: "enforce" | "warn";
  /* Whether the kernel filter and the proxy are up for the origins prepared. */
  available(): boolean;
  /* Brings the filter up for these origins (listeners, kernel rules) before a run's first child. Never throws: a failure makes `available()` false, and `mode` decides what that means. */
  prepare?(origins: readonly string[]): Promise<void>;
  /* Holds the right to reach `origins` until released. `report` is the run's: hosts the filter refuses while the lease is held are noted in it. */
  lease(origins: readonly string[], report?: SandboxReport): EgressLease;
}

/* What a child is for, named by the call site: a closed set, so the trace can group children without parsing a command line. */
export const EXEC_COMMAND_CLASSES = ["tsc", "eslint", "playwright-list", "playwright-test", "npm-ci", "login", "dom-capture", "browser", "code-test", "other"] as const;
export type ExecCommandClass = (typeof EXEC_COMMAND_CLASSES)[number];

export interface ExecSpawnOptions {
  cwd: string;
  profile: SandboxProfile;
  /* What the child is for, for its span. Absent: other. */
  commandClass?: ExecCommandClass;
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
  /* Writes a script the orchestrator authored into the run's work dir, readable and not writable by the sandbox, and returns its path. */
  writeScript(name: string, content: string): string;
}

export interface ExecSandboxDeps {
  sandbox: Sandbox | null;
  mode: ExecSandboxMode;
  /* The orchestrator's environment, the base the profiles allowlist from. */
  baseEnv: NodeJS.ProcessEnv;
  egress?: EgressGate;
  /* The boot check of the file boundary. With `required` a boundary that does not hold refuses every spawn (E-SANDBOX); with `best-effort` the child runs and the launcher says so. Absent: nothing is checked (no sandbox uid, or a caller outside the container). */
  fileBoundary?: FileBoundaryGate;
  /* The mirrors volume: a child whose cwd is in one of its mirrors gets that mirror's group opened to the sandbox for the run (mirror-access.ts). */
  mirrorRoot?: string;
  mirrorOps?: MirrorFsOps;
  /* QA_EGRESS_MODE as the composition root resolved it. With `enforce` and no sandbox uid there is no filter to hold a child (it matches on that uid), so the spawn is refused instead of quietly running unfiltered. Absent: the egress gate alone decides. */
  egressMode?: "enforce" | "warn";
  /* Ends what an earlier child left running as the sandbox uid (sandbox-reaper.ts): before each spawn and when the last live child exits. Absent: nothing is reaped (no sandbox uid, or not Linux). */
  reaper?: SandboxReaper;
  /* Absent: children are not traced. Present: each child is a `qayaba.exec` span from its spawn to its close. A child is given no trace context (no TRACEPARENT): the sandbox uid cannot reach a collector by design. */
  telemetry?: TelemetryPort;
  /* How long after a child's exit its span waits for "close" before ending anyway. */
  exitGraceMs?: number;
  /* The spawn primitive; a test passes a fake. */
  spawnFn?: typeof nodeSpawn;
  warn?: (line: string) => void;
}

export function createExecSandbox(deps: ExecSandboxDeps): ExecSandboxPort {
  const spawnFn = deps.spawnFn ?? nodeSpawn;
  const warn = deps.warn ?? ((line: string): void => console.warn(line));
  const telemetry = deps.telemetry ? guardTelemetry(deps.telemetry) : undefined;

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

      /* The uid is only a boundary where the filesystems enforce it: a secret the sandbox uid can read, or code and config it can write, make the drop to that uid worth nothing. */
      if (deps.sandbox !== null && deps.fileBoundary) {
        const breach = deps.fileBoundary.breach();
        if (breach !== undefined) {
          if (deps.mode === "required") {
            scope.report.refusal = "files";
            throw new SandboxUnavailableError("files", `refusing to spawn ${cmd}: QA_EXEC_SANDBOX=required but the file boundary does not hold on this host (${breach})`);
          }
          if (!warnedFileBoundary) {
            warnedFileBoundary = true;
            warn(`[qa] WARNING: QA_EXEC_SANDBOX=best-effort and the file boundary does not hold on this host (${breach}): agent-influenced code runs as the sandbox uid with those paths in reach.`);
          }
        }
      }

      /* Before anything is prepared for this child: a process an earlier child left under the same uid could read this one's environment (a login carries the account) and its files. A survivor that cannot be killed refuses the spawn. */
      if (deps.sandbox !== null && deps.reaper) {
        try {
          deps.reaper.reapOrphans();
        } catch (err) {
          if (!(err instanceof SandboxResidueError)) throw err;
          scope.report.refusal = "residue";
          throw new SandboxUnavailableError("residue", `refusing to spawn ${cmd}: ${err.message}`);
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
          lease = deps.egress.lease(originsFor(options.profile, scope), scope.report);
          if (scope.report.egress !== "unenforced") scope.report.egress = "enforced";
        }
      } else if (deps.sandbox === null && deps.egressMode === "enforce") {
        scope.report.refusal = "egress";
        throw new SandboxUnavailableError("egress", `refusing to spawn ${cmd}: QA_EGRESS_MODE=enforce but there is no sandbox uid, and the egress filter holds a uid's network, so nothing would hold this child (set QA_EGRESS_MODE=warn only on a host you do not care about)`);
      } else if (scope.report.egress === "not-applicable") {
        scope.report.egress = "unenforced";
        if (deps.sandbox === null && deps.egressMode === "warn" && !warnedNoEgress) {
          warnedNoEgress = true;
          warn("[qa] WARNING: QA_EGRESS_MODE=warn and there is no sandbox uid, so no egress filter: agent-influenced code can reach any host this machine can.");
        }
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
        ...(scope.suiteAccount ? { suiteAccount: scope.suiteAccount } : {}),
        staged,
        ...(options.account ? { account: options.account } : {}),
        ...(options.extraEnv ? { extraEnv: options.extraEnv } : {}),
      });
      const ids = sandboxSpawnOptions({}, deps.sandbox);
      /* Whatever goes wrong while the span is set up is dropped here: tracing must not touch the spawn or the lease. */
      const trace = telemetry ? openExecSpan(telemetry, scope, options) : undefined;
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
        trace?.fail(err);
        throw err;
      }
      if (deps.sandbox !== null && deps.reaper) {
        const uid = deps.sandbox.uid;
        const reaper = deps.reaper;
        /* Tracked from the moment it exists, so the reaper never takes a live child (or a descendant of one) for an orphan; and what the last live child left behind is ended as it goes. */
        trackSandboxChild(uid, child, () => {
          if (liveSandboxChildren(uid).size > 0) return;
          try {
            const reaped = reaper.reapOrphans();
            trace?.reaped(reaped);
          } catch (err) {
            console.error(`[qa] ERROR: ${err instanceof Error ? err.message : String(err)}; the next spawn is refused until they are gone`);
          }
        });
      }
      /* No "error" listener: one would swallow a spawn error at call sites that rely on it throwing. A child that fails to start is still followed by "close". */
      if (trace) {
        let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
        child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
          exited = { code, signal };
          /* A grandchild holding the child's streams can keep "close" from coming: the span then ends shortly after the exit. */
          const timer = setTimeout(() => trace.finish(code, signal), deps.exitGraceMs ?? EXIT_GRACE_MS);
          timer.unref();
        });
        child.once("close", (code: number | null, signal: NodeJS.Signals | null) => trace.finish(exited?.code ?? code, exited?.signal ?? signal));
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

/* The span of one child. Opened just before the spawn (a refusal opens none), ended once by "close" (or, failing that, shortly after "exit"). The hosts the egress filter refused while the child was alive are collected in a window of their own: every child shares the sandbox uid, so this is co-temporal, never causal. Any fault in setting it up yields no span at all. */
function openExecSpan(telemetry: TelemetryPort, scope: RunScope, options: ExecSpawnOptions) {
  let window: ReturnType<typeof openDeniedWindow> | undefined;
  try {
    let parent: ReturnType<NonNullable<RunScope["telemetry"]>["parent"]>;
    try {
      parent = scope.telemetry?.parent();
    } catch {
      parent = undefined;
    }
    const secrets = activeRunSecretScope();
    const span: SpanHandle = telemetry.startSpan("qayaba.exec", {
      kind: "internal",
      ...(parent ? { parent } : {}),
      ...(secrets ? { secrets } : {}),
      attrs: { "qayaba.exec.profile": options.profile, "qayaba.exec.command_class": options.commandClass ?? "other" },
    });
    const opened = openDeniedWindow(scope);
    window = opened;
    let killed: number | undefined;
    let done = false;
    const conclude = (attrs: Parameters<SpanHandle["setAttrs"]>[0]): void => {
      done = true;
      const hosts = opened.hosts();
      opened.close();
      span.setAttrs({ ...attrs, ...(killed !== undefined ? { "qayaba.reaper.killed": killed } : {}), ...(hosts.length > 0 ? { "qayaba.egress.denied_cotemporal": hosts } : {}) });
      if (hosts.length > 0) telemetry.counter("qayaba.egress.denied")(hosts.length, { "qayaba.exec.profile": options.profile });
    };
    return {
      /* Best effort: the reaper runs when the last live child exits, before "close", so the count is on the span only when it was known by then. */
      reaped(count: number): void {
        killed = count;
      },
      finish(code: number | null, signal: NodeJS.Signals | null): void {
        if (done) return;
        try {
          conclude({ ...(code !== null ? { "process.exit.code": code } : {}), ...(signal !== null ? { "qayaba.exec.signal": signal } : {}) });
          span.end();
        } catch {
          /* tracing never reaches the child */
        }
      },
      /* The spawn itself threw: no child, no "close". */
      fail(error: unknown): void {
        if (done) return;
        try {
          conclude({});
          span.recordError(error);
          span.end();
        } catch {
          /* tracing never reaches the spawn error */
        }
      },
    };
  } catch (err) {
    window?.close();
    console.error(`[telemetry] the span of a child could not be set up (the child starts untraced): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
