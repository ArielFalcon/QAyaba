/* The composition root's wiring of the execution sandbox: the one place that reads the process environment for it. The launcher, the per-run scope provider and the identity they run children as are built here from the environment and handed to the engine; qa-engine never reads process.env for any of it. Every launcher built here asks the boot check of the file boundary before each spawn (file-boundary.ts). */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecSandbox, resolveExecSandboxMode, type EgressGate, type ExecSandboxMode, type ExecSandboxPort } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox";
import type { ExecScopePort } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope";
import { createExecScopeProvider } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope-provider";
import type { Sandbox } from "../../qa-engine/src/shared-infrastructure/process-sandbox/sandbox";
import type { MirrorFsOps } from "../../qa-engine/src/shared-infrastructure/process-sandbox/mirror-access";
import { resolveEgressMode } from "./egress-wiring";
import { fileBoundaryGateFor } from "./file-boundary";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port";
import { processReaper } from "../../qa-engine/src/shared-infrastructure/process-sandbox/sandbox-reaper";

export interface ExecWiring {
  exec: ExecSandboxPort;
  execScope: ExecScopePort;
  sandbox: Sandbox | null;
  mode: ExecSandboxMode;
}

export interface ExecWiringInput {
  env: NodeJS.ProcessEnv;
  sandbox: Sandbox | null;
  /* The app's orchestrator-only auth directory. */
  authDir: string;
  /* The origins a suite or login child may reach, and those an install child may reach. */
  egressOrigins: { dev: readonly string[]; install: readonly string[] };
  egress?: EgressGate;
  workRoot?: string;
  /* The mirrors volume, so that the mirror a child runs in is opened to the sandbox group for the run. */
  mirrorRoot?: string;
  /* The account handed to the suite children of an app that opted in (e2e.specCredentials: account). */
  suiteAccount?: { user: string; pass: string };
  /* Each child the launcher starts becomes a span of the run's trace. Absent: children are not traced. */
  telemetry?: TelemetryPort;
}

/* Where the per-run work directories live: `/tmp/qa-exec` in the container. */
export function execWorkRoot(env: NodeJS.ProcessEnv): string {
  return env.QA_EXEC_ROOT && env.QA_EXEC_ROOT !== "" ? env.QA_EXEC_ROOT : join(tmpdir(), "qa-exec");
}

/* The DEV gate's HTTP Basic credentials, when the app has one; they are the run's, not the child's to inherit. */
export function gateCredsFrom(env: NodeJS.ProcessEnv): { user: string; pass: string } | undefined {
  return env.DEV_ENV_USER ? { user: env.DEV_ENV_USER, pass: env.DEV_ENV_PASS ?? "" } : undefined;
}

export function buildExecWiring(input: ExecWiringInput): ExecWiring {
  const mode = resolveExecSandboxMode(input.env);
  const reaper = processReaper(input.sandbox);
  const exec = createExecSandbox({ sandbox: input.sandbox, mode, egressMode: resolveEgressMode(input.env), baseEnv: input.env, fileBoundary: fileBoundaryGateFor(input.env), ...(input.egress ? { egress: input.egress } : {}), ...(input.mirrorRoot ? { mirrorRoot: input.mirrorRoot } : {}), ...(reaper ? { reaper } : {}), ...(input.telemetry ? { telemetry: input.telemetry } : {}) });
  const gateCreds = gateCredsFrom(input.env);
  const execScope = createExecScopeProvider({
    workRoot: input.workRoot ?? execWorkRoot(input.env),
    sandbox: input.sandbox,
    authDir: input.authDir,
    ...(gateCreds ? { gateCreds } : {}),
    egress: input.egressOrigins,
    ...(input.egress ? { egressGate: input.egress } : {}),
    ...(input.mirrorRoot ? { mirrorRoot: input.mirrorRoot } : {}),
    ...(input.suiteAccount ? { suiteAccount: input.suiteAccount } : {}),
    ...(reaper ? { reaper } : {}),
  });
  return { exec, execScope, sandbox: input.sandbox, mode };
}

/* The same sandbox for the operator scripts that run suites outside the queue (the baseline arm, the campaign's re-runs). Each script step opens a scope of its own, since it has no run to borrow one from. */
export interface ScriptExec {
  exec: ExecSandboxPort;
  sandbox: Sandbox | null;
  scoped<T>(scope: { runId: string; authDir?: string; devOrigins?: readonly string[]; installOrigins?: readonly string[] }, fn: () => Promise<T>): Promise<T>;
}

/* The mirrors volume the scripts' copies live in (MIRROR_DIR): the mirror a script's child runs in is opened to the sandbox group as a run's is, and every scope seals the mirrors when it opens and when it closes. Unset: no mirror is touched. */
export interface ScriptMirrors {
  mirrorRoot?: string;
  mirrorOps?: MirrorFsOps;
}

export function buildScriptExec(env: NodeJS.ProcessEnv, sandbox: Sandbox | null, egress?: EgressGate, mirrors: ScriptMirrors = {}): ScriptExec {
  const mode = resolveExecSandboxMode(env);
  const reaper = processReaper(sandbox);
  const mirrorRoot = mirrors.mirrorRoot ?? (env.MIRROR_DIR && env.MIRROR_DIR !== "" ? env.MIRROR_DIR : undefined);
  const mirrorDeps = mirrorRoot ? { mirrorRoot, ...(mirrors.mirrorOps ? { mirrorOps: mirrors.mirrorOps } : {}) } : {};
  const exec = createExecSandbox({ sandbox, mode, egressMode: resolveEgressMode(env), baseEnv: env, fileBoundary: fileBoundaryGateFor(env), ...(egress ? { egress } : {}), ...mirrorDeps, ...(reaper ? { reaper } : {}) });
  const gateCreds = gateCredsFrom(env);
  return {
    exec,
    sandbox,
    async scoped(scope, fn) {
      const session = await createExecScopeProvider({
        workRoot: execWorkRoot(env),
        sandbox,
        ...(scope.authDir ? { authDir: scope.authDir } : {}),
        ...(gateCreds ? { gateCreds } : {}),
        egress: { dev: scope.devOrigins ?? [], install: scope.installOrigins ?? [] },
        ...(egress ? { egressGate: egress } : {}),
        ...mirrorDeps,
        ...(reaper ? { reaper } : {}),
      }).open({ runId: scope.runId });
      try {
        return await session.run(fn);
      } finally {
        session.close();
      }
    },
  };
}

/* The account an opted-in app's specs may log in with: the one its auth declaration names, else the conventional DEV_TEST_USER / DEV_TEST_PASS. None when the app did not opt in, or the environment holds no such account. */
export function suiteAccountFor(
  app: { e2e?: { specCredentials?: "none" | "account" | undefined } | undefined; auth?: { usernameEnv?: string | undefined; passwordEnv?: string | undefined } | undefined },
  env: NodeJS.ProcessEnv,
): { user: string; pass: string } | undefined {
  if (app.e2e?.specCredentials !== "account") return undefined;
  const user = env[app.auth?.usernameEnv ?? "DEV_TEST_USER"];
  const pass = env[app.auth?.passwordEnv ?? "DEV_TEST_PASS"];
  return user && pass ? { user, pass } : undefined;
}
