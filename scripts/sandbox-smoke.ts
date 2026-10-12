/*
 * In-container smoke test of the execution sandbox: `docker compose exec orchestrator npm run sandbox:smoke`.
 *
 * The unit tests prove the rules (what each profile's environment holds, what the iptables documents say, what the proxy
 * lets through); only the running container can prove that the kernel, the file permissions and the sandbox uid
 * actually behave that way, and Docker Desktop's kernel in particular cannot be assumed. This script runs the specs of
 * scripts/sandbox-smoke/ through the REAL runner (the same launcher, profile, uid, work dir and egress filter a
 * production run gets) against a throwaway mirror, with canary secrets planted in this process's environment, and
 * every spec passes only when the isolation holds: it reads /proc/1/environ, /app/data, /app/config/.api_token (all
 * must be EACCES), writes the mirror it runs in and another mirror (must fail), fetches an undeclared host, sends raw UDP
 * and IPv6 and connects to the API on loopback (all must fail), reads the canary secrets from its environment (must be
 * absent), and loads the one declared origin in a real browser (must succeed).
 *
 * Exit 0 only when every expected case ran and passed. It changes nothing but a throwaway mirror under the mirrors volume.
 *   QA_SMOKE_ORIGIN       the one origin declared reachable (default https://example.com)
 *   QA_SMOKE_UNDECLARED   a host that must NOT be reachable (default https://example.org)
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QaCase } from "../qa-engine/src/shared-kernel/qa-case.ts";

export const SMOKE_SPEC_DIR = join(import.meta.dirname, "sandbox-smoke");

export interface SmokeVerdict {
  ok: boolean;
  problems: string[];
}

/* The smoke run is green only when the runner passed, every case passed, and as many cases ran as specs promise: a spec that did not run proves nothing. */
export function evaluateSmoke(run: { verdict: string; cases: ReadonlyArray<Pick<QaCase, "name" | "status">> }, expectedCases: number): SmokeVerdict {
  const problems: string[] = [];
  if (run.verdict !== "pass") problems.push(`the run's verdict is ${run.verdict}, not pass`);
  for (const c of run.cases) if (c.status !== "pass") problems.push(`${c.status}: ${c.name}`);
  if (run.cases.length < expectedCases) problems.push(`only ${run.cases.length} of ${expectedCases} expected cases ran`);
  return { ok: problems.length === 0, problems };
}

/* Counts the `test(` declarations of the smoke specs, so the number of cases expected follows the files. */
export function countSmokeCases(specSources: readonly string[]): number {
  return specSources.reduce((sum, source) => sum + (source.match(/^test\(/gm)?.length ?? 0), 0);
}

const CANARIES: Record<string, string> = {
  DEV_TEST_USER: "smoke-canary-user",
  DEV_TEST_PASS: "smoke-canary-pass",
  GITHUB_TOKEN: "smoke-canary-github",
  QA_API_TOKEN: "smoke-canary-api",
  OPENCODE_API_KEY: "smoke-canary-oc",
  WEBHOOK_SECRET: "smoke-canary-hook",
};

async function main(): Promise<number> {
  const { readFileSync } = await import("node:fs");
  const env = process.env;
  const origin = env.QA_SMOKE_ORIGIN || "https://example.com";
  const undeclared = env.QA_SMOKE_UNDECLARED || "https://example.org";

  const { resolveCodeSandbox, buildSetupAdapter } = await import("../src/server/rewritten-engine-factory.ts");
  const { buildExecWiring } = await import("../src/server/exec-sandbox-factory.ts");
  const { egressGateFor, loadRegistryGroups, resolveRunOrigins } = await import("../src/server/egress-wiring.ts");
  const { qayabaRoot } = await import("../src/paths.ts");
  const { workdirRoot } = await import("../src/integrations/repo-mirror.ts");
  const { runE2E, createDefaultE2eExecuteDeps, e2eTimeoutMs } = await import("../qa-engine/src/contexts/test-execution/infrastructure/e2e-execution.runner.ts");
  const { ProcessKillAdapter } = await import("../qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter.ts");

  const sandbox = resolveCodeSandbox(env);
  if (!sandbox) {
    console.error("sandbox:smoke: there is no sandbox uid here (not root on Linux, the image lacks the sandbox user, or CODE_SANDBOX=off). Run it inside the orchestrator container.");
    return 2;
  }
  const gate = egressGateFor(env, sandbox);
  const mirrors = workdirRoot();
  const mirror = join(mirrors, "__sandbox-smoke__");
  const other = join(mirrors, "__sandbox-smoke-other__");
  const e2eDir = join(mirror, "e2e");
  const authDir = join(mirrors, "__sandbox-smoke__.auth");
  for (const dir of [mirror, other, authDir]) rmSync(dir, { recursive: true, force: true });
  mkdirSync(e2eDir, { recursive: true });
  mkdirSync(other, { recursive: true });
  mkdirSync(authDir, { recursive: true, mode: 0o700 });

  const specFiles = readdirSync(SMOKE_SPEC_DIR).filter((f) => f.endsWith(".spec.ts")).sort();
  const expected = countSmokeCases(specFiles.map((f) => readFileSync(join(SMOKE_SPEC_DIR, f), "utf8")));
  const registries = loadRegistryGroups(qayabaRoot());
  const runOrigins = resolveRunOrigins({ dev: { baseUrl: origin } }, "e2e", registries);
  const wiring = buildExecWiring({ env, sandbox, authDir, mirrorRoot: mirrors, egressOrigins: runOrigins, ...(gate ? { egress: gate } : {}) });
  const saved = Object.fromEntries(Object.keys(CANARIES).map((k) => [k, env[k]]));
  Object.assign(env, CANARIES);
  const session = await wiring.execScope.open({ runId: `sandbox-smoke-${Date.now()}` });
  try {
    return await session.run(async () => {
      console.log(`sandbox:smoke: seeding a throwaway project in ${e2eDir} and installing it as uid ${sandbox.uid} (egress ${gate ? `${gate.mode}` : "n/a"})`);
      await buildSetupAdapter(wiring.exec, sandbox).setup(e2eDir);
      for (const f of specFiles) cpSync(join(SMOKE_SPEC_DIR, f), join(e2eDir, f));
      writeFileSync(join(e2eDir, "smoke-context.json"), JSON.stringify({ otherMirror: other, undeclared, apiPort: Number(env.PORT ?? 458) }));
      const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), e2eTimeoutMs(env), wiring.exec);
      const run = await runE2E(e2eDir, { baseUrl: origin, namespace: "sandbox-smoke", specFiles }, deps);
      for (const c of run.cases) console.log(`  ${c.status === "pass" ? "ok  " : "FAIL"} ${c.name}${c.status === "pass" ? "" : ` — ${c.detail ?? ""}`}`);
      const verdict = evaluateSmoke(run, expected);
      if (!verdict.ok) {
        for (const problem of verdict.problems) console.error(`sandbox:smoke: ${problem}`);
        if (run.logs) console.error(run.logs.slice(0, 2000));
        console.error("sandbox:smoke: the sandbox does NOT hold on this host. Do not run agent code here until this is fixed.");
        return 1;
      }
      console.log(`sandbox:smoke: ${run.cases.length} isolation checks passed`);
      return 0;
    });
  } finally {
    session.close();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete env[key]; else env[key] = value;
    for (const dir of [mirror, other, authDir]) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
