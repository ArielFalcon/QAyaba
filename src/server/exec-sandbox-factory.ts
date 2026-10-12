/* The composition root's wiring of the execution sandbox: the one place that reads the process environment for it. The launcher, the per-run scope provider and the identity they run children as are built here from the environment and handed to the engine; qa-engine never reads process.env for any of it. */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecSandbox, resolveExecSandboxMode, type EgressGate, type ExecSandboxMode, type ExecSandboxPort } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox";
import type { ExecScopePort } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope";
import { createExecScopeProvider } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope-provider";
import type { Sandbox } from "../../qa-engine/src/shared-infrastructure/process-sandbox/sandbox";

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
  const exec = createExecSandbox({ sandbox: input.sandbox, mode, baseEnv: input.env, ...(input.egress ? { egress: input.egress } : {}) });
  const gateCreds = gateCredsFrom(input.env);
  const execScope = createExecScopeProvider({
    workRoot: input.workRoot ?? execWorkRoot(input.env),
    sandbox: input.sandbox,
    authDir: input.authDir,
    ...(gateCreds ? { gateCreds } : {}),
    egress: input.egressOrigins,
  });
  return { exec, execScope, sandbox: input.sandbox, mode };
}

/* The same sandbox for the operator scripts that run suites outside the queue (the baseline arm, the campaign's re-runs). Each script step opens a scope of its own, since it has no run to borrow one from. */
export interface ScriptExec {
  exec: ExecSandboxPort;
  sandbox: Sandbox | null;
  scoped<T>(scope: { runId: string; authDir?: string; devOrigins?: readonly string[]; installOrigins?: readonly string[] }, fn: () => Promise<T>): Promise<T>;
}

export function buildScriptExec(env: NodeJS.ProcessEnv, sandbox: Sandbox | null, egress?: EgressGate): ScriptExec {
  const mode = resolveExecSandboxMode(env);
  const exec = createExecSandbox({ sandbox, mode, baseEnv: env, ...(egress ? { egress } : {}) });
  const gateCreds = gateCredsFrom(env);
  return {
    exec,
    sandbox,
    async scoped(scope, fn) {
      const session = createExecScopeProvider({
        workRoot: execWorkRoot(env),
        sandbox,
        ...(scope.authDir ? { authDir: scope.authDir } : {}),
        ...(gateCreds ? { gateCreds } : {}),
        egress: { dev: scope.devOrigins ?? [], install: scope.installOrigins ?? [] },
      }).open({ runId: scope.runId });
      try {
        return await session.run(fn);
      } finally {
        session.close();
      }
    },
  };
}
