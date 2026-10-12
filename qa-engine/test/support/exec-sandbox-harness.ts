/* A real execution launcher for tests that run the real runners against stand-in binaries: no sandbox uid (the tests do not run as root), best-effort, and a run scope of its own made under os.tmpdir() when the call is not inside one. The process boundary stays real; only the privilege drop is absent. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecSandbox, type EgressGate, type ExecSandboxPort } from "../../src/shared-infrastructure/process-sandbox/exec-sandbox.ts";
import { activeExecScope, newSandboxReport, type RunScope } from "../../src/shared-infrastructure/process-sandbox/exec-scope.ts";
import { openRunWorkDir, writeWorkScript } from "../../src/shared-infrastructure/process-sandbox/exec-workdir.ts";

export interface TestExecOptions {
  baseEnv?: NodeJS.ProcessEnv;
  authDir?: string;
  egress?: EgressGate;
  egressOrigins?: { dev: readonly string[]; install: readonly string[] };
  gateCreds?: { user: string; pass: string };
}

let counter = 0;

export function testExecSandbox(options: TestExecOptions = {}): { exec: ExecSandboxPort; scope: RunScope; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), "test-exec-"));
  const workDir = openRunWorkDir(join(root, "exec"), `test-run-${process.pid}-${(counter += 1)}`, null);
  const scope: RunScope = {
    runId: "test-run",
    workDir,
    ...(options.authDir ? { authDir: options.authDir } : {}),
    ...(options.gateCreds ? { gateCreds: options.gateCreds } : {}),
    egress: options.egressOrigins ?? { dev: [], install: [] },
    report: newSandboxReport(),
  };
  const inner = createExecSandbox({
    sandbox: null,
    mode: "best-effort",
    baseEnv: options.baseEnv ?? process.env,
    ...(options.egress ? { egress: options.egress } : {}),
    warn: () => {},
  });
  const exec: ExecSandboxPort = {
    isolated: inner.isolated,
    spawn: (cmd, args, o) => inner.spawn(cmd, args, { ...o, scope: o.scope ?? activeExecScope() ?? scope }),
    workDir: (s) => inner.workDir(s ?? activeExecScope() ?? scope),
    allocDir: (prefix, subdirs, s) => inner.allocDir(prefix, subdirs, s ?? activeExecScope() ?? scope),
    prepareWritable: (dirs) => inner.prepareWritable(dirs),
    writeScript: (name, content) => (activeExecScope() ? inner.writeScript(name, content) : writeWorkScript(scope.workDir, name, content)),
  };
  return { exec, scope, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

let shared: ExecSandboxPort | undefined;

/* One launcher for the whole test process, cleaned up when it exits. */
export function sharedTestExec(): ExecSandboxPort {
  if (shared === undefined) {
    const made = testExecSandbox();
    process.on("exit", made.dispose);
    shared = made.exec;
  }
  return shared;
}
