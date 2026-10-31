import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubEnv, scrubEnvFrom } from "../../../src/shared-infrastructure/process-sandbox/scrub-env.ts";
/* NOTE: 3 leading ../ from qa-engine/test/shared-infrastructure/process-sandbox/ to qa-engine/src/ */

/* Safe env restore: `process.env = orig` assigns Record<string,string|undefined> to NodeJS.ProcessEnv
   and fails strict typecheck. Use per-key save/restore instead: delete keys added during the test,
   then Object.assign to restore modified values.
 */

test("scrubEnv drops secrets even if extraAllowed would match", () => {
  const added = ["GITHUB_TOKEN", "DOPPLER_TOKEN"] as const;
  const saved: Partial<Record<string, string>> = {};
  for (const k of added) { saved[k] = process.env[k]; process.env[k] = k === "GITHUB_TOKEN" ? "ghp_secret" : "dp_secret"; }
  try {
    const out = scrubEnv({ extraAllowed: /^GITHUB_/ }); /* even though caller widens to GITHUB_*, secrets stay blocked */
    assert.equal("GITHUB_TOKEN" in out, false);
    assert.equal("DOPPLER_TOKEN" in out, false);
  } finally {
    for (const k of added) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test("scrubEnv drops the OpenCode server password even if extraAllowed would match", () => {
  const key = "OPENCODE_SERVER_PASSWORD";
  const saved = process.env[key];
  try {
    process.env[key] = "server-secret";
    assert.equal(key in scrubEnv({ extraAllowed: /^OPENCODE_/ }), false);
  } finally {
    if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
  }
});

test("scrubEnv keeps OS + language essentials and forwards PLAYWRIGHT_BROWSERS_PATH", () => {
  const added = ["PATH", "PLAYWRIGHT_BROWSERS_PATH"] as const;
  const saved: Partial<Record<string, string>> = {};
  for (const k of added) saved[k] = process.env[k];
  try {
    process.env.PATH = "/usr/bin";
    process.env.PLAYWRIGHT_BROWSERS_PATH = "/ms-playwright";
    const out = scrubEnv();
    assert.equal(out.PATH, "/usr/bin");
    assert.equal(out.PLAYWRIGHT_BROWSERS_PATH, "/ms-playwright");
  } finally {
    for (const k of added) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test("scrubEnv honors an extra allow prefix for non-secret vars (e2e DEV_*)", () => {
  const key = "DEV_LOGIN_USER";
  const savedVal = process.env[key];
  try {
    process.env[key] = "alice";
    assert.equal(scrubEnv({ extraAllowed: /^DEV_/ })[key], "alice");
    assert.equal(key in scrubEnv(), false); /* dropped without the widening */
  } finally {
    if (savedVal === undefined) delete process.env[key]; else process.env[key] = savedVal;
  }
});

/* the allowlist must keep whole FAMILIES of package-manager/locale vars (npm_config_*, PIP_*, PNPM_*,
   LC_*), not just the bare prefix string: otherwise `npm ci` loses its registry/cache/proxy config.
   This test did not previously exist in this file (the pre-migration qa-engine twin lacked it); ported
   here to close the gap, not duplicate it.
 */
test("scrubEnv preserves prefix-family package-manager vars (npm_config_*, PIP_*, PNPM_*, LC_*) while still blocking secret families", () => {
  const added = ["npm_config_cache", "npm_config_registry", "PIP_CACHE_DIR", "PNPM_HOME", "LC_ALL", "DOPPLER_TOKEN"] as const;
  const saved: Partial<Record<string, string>> = {};
  for (const k of added) saved[k] = process.env[k];
  try {
    process.env.npm_config_cache = "/cache";
    process.env.npm_config_registry = "https://registry.local";
    process.env.PIP_CACHE_DIR = "/home/u/.cache/pip";
    process.env.PNPM_HOME = "/home/u/.pnpm";
    process.env.LC_ALL = "C.UTF-8";
    process.env.DOPPLER_TOKEN = "dp_fakeSecret"; /* a secret family → must STILL be dropped */
    const env = scrubEnv({ quiet: true });
    assert.equal(env.npm_config_cache, "/cache", "npm_config_* must be preserved (npm ci needs it)");
    assert.equal(env.npm_config_registry, "https://registry.local");
    assert.equal(env.PIP_CACHE_DIR, "/home/u/.cache/pip");
    assert.equal(env.PNPM_HOME, "/home/u/.pnpm");
    assert.equal(env.LC_ALL, "C.UTF-8");
    assert.ok(!("DOPPLER_TOKEN" in env), "DOPPLER_ secrets must still be blocked");
  } finally {
    for (const k of added) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

/* Every spawn the sandbox serves runs the e2e project, a Playwright TypeScript project whatever the app's own stack is (ADR-0007, ADR-0020): the variables of other toolchains only widen what an agent-influenced process receives. */
test("scrubEnvFrom passes none of the JVM, Go or Rust toolchain variables", () => {
  const toolchain = [
    "JAVA_HOME", "M2_HOME", "M2_REPO", "M2", "GRADLE_USER_HOME", "GRADLE_OPTS", "MAVEN_OPTS", "MAVEN_CONFIG",
    "GOPATH", "GOROOT", "GOPRIVATE", "GOPROXY", "GONOSUMCHECK", "GOFLAGS", "GOCACHE", "CGO_ENABLED",
    "CARGO_HOME", "CARGO_TARGET_DIR", "RUSTUP_HOME", "RUST_BACKTRACE",
  ];
  const source: Record<string, string> = { PATH: "/usr/bin", npm_config_cache: "/cache" };
  for (const name of toolchain) source[name] = "/toolchain";
  assert.deepEqual(scrubEnvFrom(source, { quiet: true }), { PATH: "/usr/bin", npm_config_cache: "/cache" });
});

test("scrubEnvFrom drops the Langfuse project keys even if a caller widens the allowlist to LANGFUSE_", () => {
  const out = scrubEnvFrom({ PATH: "/usr/bin", LANGFUSE_PUBLIC_KEY: "pk-lf-x", LANGFUSE_SECRET_KEY: "sk-lf-x" }, { extraAllowed: /^LANGFUSE_/, quiet: true });
  assert.deepEqual(out, { PATH: "/usr/bin" });
});

test("scrubEnv drops any provider's API key, whatever the provider is named, even if extraAllowed would match", () => {
  const key = "SOMEPROVIDER_API_KEY";
  const saved = process.env[key];
  process.env[key] = "provider-secret";
  try {
    assert.equal(key in scrubEnv({ extraAllowed: /^SOMEPROVIDER_/ }), false);
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

test("the variables left out are named once per process for the same set, not on every spawn", (t) => {
  const warned: string[] = [];
  t.mock.method(console, "warn", (line: string) => void warned.push(line));
  const source = { PATH: "/bin", QA_ONLY_ONCE_A: "1", QA_ONLY_ONCE_B: "2" };
  scrubEnvFrom(source);
  scrubEnvFrom(source);
  assert.equal(warned.filter((l) => l.includes("QA_ONLY_ONCE_A")).length, 1);
  scrubEnvFrom({ ...source, QA_ONLY_ONCE_C: "3" });
  assert.equal(warned.filter((l) => l.includes("QA_ONLY_ONCE_C")).length, 1, "a different set is named again");
});
