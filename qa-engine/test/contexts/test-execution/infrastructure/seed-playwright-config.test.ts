/* The seed playwright.config.ts decides which projects a suite run executes: the runner passes no
   --project unless one is configured, so every project the config defines runs. The login setup
   project must therefore exist only for the orchestrator's own setup run. The seed is evaluated the
   way Playwright evaluates it, against a stub @playwright/test (this template does not install
   Playwright), from a temp copy so nothing is written into the tracked tree. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AuthSessionAdapter } from "@contexts/qa-run-orchestration/infrastructure/auth-session.adapter.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..", "..");
const SEED_CONFIG = join(repoRoot, "config", "e2e", "playwright.config.ts");
/* The project the orchestrator's login setup run selects (`playwright test --project=setup`). */
const SETUP_PROJECT = "setup";

let evaluation = 0;

async function projectNamesUnder(env: Record<string, string>): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "seed-pw-config-"));
  const stub = join(dir, "node_modules", "@playwright", "test");
  mkdirSync(stub, { recursive: true });
  writeFileSync(join(stub, "package.json"), JSON.stringify({ name: "@playwright/test", type: "module", main: "index.js" }));
  writeFileSync(join(stub, "index.js"), "export const defineConfig = (c) => c;\nexport const devices = new Proxy({}, { get: () => ({}) });\n");
  copyFileSync(SEED_CONFIG, join(dir, "playwright.config.ts"));

  const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    evaluation += 1;
    const url = `${pathToFileURL(join(dir, "playwright.config.ts")).href}?evaluation=${evaluation}`;
    const config = (await import(url)).default as { projects?: Array<{ name?: string }> };
    return (config.projects ?? []).map((p) => p.name ?? "");
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/* The env the orchestrator hands its login setup run, captured at the spawn boundary. */
async function loginSetupRunEnv(): Promise<Record<string, string>> {
  let captured: Record<string, string> = {};
  const specDir = mkdtempSync(join(tmpdir(), "seed-pw-spec-"));
  const authDir = mkdtempSync(join(tmpdir(), "seed-pw-auth-"));
  try {
    const adapter = new AuthSessionAdapter({
      env: { QA_USER: "u", QA_PASS: "p" },
      readSeedAuthSetup: () => "/* qa-auth-setup-seed */\n",
      authDir,
      spawnSetup: async (_dir, env) => {
        captured = env;
        writeFileSync(env.PW_STORAGE_STATE ?? join(authDir, "user.json"), "{}");
        return { exitCode: 0, logs: "" };
      },
    });
    await adapter.prepare({
      specDir,
      baseUrl: "https://dev.example",
      phase: "pre-execute",
      auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" },
    });
    return captured;
  } finally {
    rmSync(specDir, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
  }
}

test("a suite run of the seed config runs its test projects but never the login setup project", async () => {
  const names = await projectNamesUnder({});
  assert.ok(names.length > 0, "the seed must define at least one suite project");
  assert.equal(names.includes(SETUP_PROJECT), false, `the setup project would run as a suite case: ${JSON.stringify(names)}`);
});

test("the orchestrator's login setup run sees the seed's setup project", async () => {
  const names = await projectNamesUnder(await loginSetupRunEnv());
  assert.ok(names.includes(SETUP_PROJECT), `the setup run must find the setup project: ${JSON.stringify(names)}`);
});
