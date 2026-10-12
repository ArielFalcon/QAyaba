/*
 * The login the pipeline's harness makes for its own runs, usable from an experiment script: the session lands in an
 * orchestrator-side directory (never a file an agent can read) and the suite's tests find it there. Shared by the plain-agent
 * arm (scripts/baseline-agent.ts) and the campaign's validity re-runs (scripts/campaign.ts), so both log in as the pipeline does.
 * An I/O boundary, imported lazily so a test that injects its own never loads the engine.
 */
import { join } from "node:path";

export interface HarnessAuthInput {
  appName: string;
  baseUrl: string;
  testIdAttribute?: string;
  /** The suite directory whose `auth.setup.ts` makes the login. */
  specDir: string;
  /** The orchestrator-side directory the session is written to. */
  authDir: string;
  phase: "pre-generate" | "pre-execute";
}

export async function prepareHarnessAuth(input: HarnessAuthInput): Promise<{ unauthored: boolean }> {
  const { loadAppConfig } = await import("../src/orchestrator/config-loader.ts");
  const { ProcessKillAdapter } = await import("../qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter.ts");
  const { SandboxedBinaryRunnerAdapter } = await import("../qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter.ts");
  const { AuthSessionAdapter } = await import("../qa-engine/src/contexts/qa-run-orchestration/infrastructure/auth-session.adapter.ts");
  const { createDiscoverLogin } = await import("../qa-engine/src/contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.runner.ts");
  const { loadContextMapFromDisk } = await import("../qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/pre-generation-grounding-port.adapter.ts");
  const { RedactionPortAdapter } = await import("../src/orchestrator/sanitizer.ts");
  const redaction = new RedactionPortAdapter();
  const runner = new SandboxedBinaryRunnerAdapter({ processKill: new ProcessKillAdapter() });
  const adapter = new AuthSessionAdapter({
    env: process.env,
    authDir: input.authDir,
    ...(input.testIdAttribute !== undefined ? { testIdAttribute: input.testIdAttribute } : {}),
    /* The login the pipeline's harness gives its own runs, discovery included: authentication is infrastructure and every arm gets the same. */
    discovery: { discoverLogin: createDiscoverLogin({ runner }), redact: (text: string) => redaction.redact(text), loadContextMap: loadContextMapFromDisk },
    spawnSetup: async (specDir, childEnv, signal) => {
      const result = await runner.run({ command: "npx", args: ["playwright", "test", "--project=setup"], cwd: specDir, env: childEnv, timeoutMs: 120_000, ...(signal ? { signal } : {}) });
      const logs = `${result.stdout}\n${result.stderr}`;
      return { exitCode: result.timedOut ? 1 : (result.exitCode ?? 1), logs: result.timedOut ? `auth setup timed out\n${logs}` : logs };
    },
  });
  const loaded = loadAppConfig(input.appName);
  const session = await adapter.prepare({ specDir: input.specDir, baseUrl: input.baseUrl, ...(loaded.auth ? { auth: loaded.auth } : {}), phase: input.phase });
  return { unauthored: session.unauthored };
}

export const authDirBeside = (workspace: string): string => join(`${workspace}.auth`);
