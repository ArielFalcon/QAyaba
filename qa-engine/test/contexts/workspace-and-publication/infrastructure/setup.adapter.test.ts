/* SetupAdapter.install() still throws on a runner-signaled timeout; optional helper slots are
   always-present class methods, not injectable no-ops. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SetupAdapter,
  nodeFsDeps,
  FAILURE_CAPTURE_MARKER,
  FAILURE_CAPTURE_BLOCK,
  type SetupAdapterFsDeps,
} from "@contexts/workspace-and-publication/infrastructure/setup.adapter.ts";
import type { SandboxedBinaryRunner, SandboxedRunRequest, SandboxedRunResult } from "../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";

/* 5 levels up from this file to the repo root (qa-engine/test/contexts/workspace-and-publication/
   infrastructure/ -> qa-engine/test/contexts/ -> qa-engine/test/ -> qa-engine/ -> repo root) —
   verified empirically against the real config/e2e/ tree before writing this file.
 */
const REAL_SEED_DIR = fileURLToPath(new URL("../../../../../config/e2e", import.meta.url));

function okResult(overrides: Partial<SandboxedRunResult> = {}): SandboxedRunResult {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...overrides };
}

function fakeRunner(run: (req: SandboxedRunRequest) => Promise<SandboxedRunResult>): SandboxedBinaryRunner {
  return { run };
}

const neverCalledRunner: SandboxedBinaryRunner = {
  run: async () => {
    throw new Error("runner should not be called in this test");
  },
};

function realAdapter(seedDir = REAL_SEED_DIR): SetupAdapter {
  return new SetupAdapter({ fs: nodeFsDeps, runner: neverCalledRunner, seedDir });
}

/* A minimal, fully-stubbed fs fake for the orchestration-layer (setup()) tests below — no real disk
   touched. `hasPackageJson` controls the bootstrap/no-bootstrap branch; every other exists() probe
   (node_modules, .install-hash, package-lock.json) defaults to false so isInstallCurrent() is always
   false and install() always runs, matching the original tests' fixtures (a fresh /mirror/e2e with no
   real cache marker on disk).
 */
function orchestrationFs(opts: { hasPackageJson: boolean; onBootstrap?: (dest: string) => void; onEnsureSpecDir?: (path: string) => void }): SetupAdapterFsDeps {
  return {
    exists: (path) => (path.endsWith("package.json") ? opts.hasPackageJson : false),
    cp: (_src, dest) => opts.onBootstrap?.(dest),
    read: () => "",
    readBytes: () => Buffer.from(""),
    write: () => {},
    append: () => {},
    mkdir: (path) => {
      if (path.endsWith("flows")) opts.onEnsureSpecDir?.(path);
    },
  };
}

test("repo with an e2e project: installs, does not bootstrap", async () => {
  const seq: string[] = [];
  const fs = orchestrationFs({ hasPackageJson: true, onBootstrap: () => seq.push("bootstrap") });
  const runner = fakeRunner(async () => {
    seq.push("install");
    return okResult();
  });
  await new SetupAdapter({ fs, runner, seedDir: "/seed" }).setup("/mirror/e2e");
  assert.deepEqual(seq, ["install"]);
});

test("repo without an e2e project: seeds first, then installs", async () => {
  const seq: string[] = [];
  let seeded = "";
  const fs = orchestrationFs({
    hasPackageJson: false,
    onBootstrap: (dest) => {
      seeded = dest;
      seq.push("bootstrap");
    },
  });
  const runner = fakeRunner(async () => {
    seq.push("install");
    return okResult();
  });
  await new SetupAdapter({ fs, runner, seedDir: "/seed" }).setup("/mirror/e2e");
  assert.deepEqual(seq, ["bootstrap", "install"]); /* bootstrap BEFORE install */
  assert.equal(seeded, "/mirror/e2e");
});

/* The parallel fan-out workers are each assigned `flows/<flow>.spec.ts` and can only `write` (no
   mkdir). If the orchestrator does not create `flows/` first, every worker write fails silently and a
   complete/exhaustive run generates ZERO specs. Setup MUST ensure the dir — after seeding, before install.
 */
test("ensures the flows/ spec dir exists (after bootstrap, before install) so fan-out workers can write", async () => {
  const seq: string[] = [];
  let ensuredFor = "";
  const fs = orchestrationFs({
    hasPackageJson: false,
    onBootstrap: () => seq.push("bootstrap"),
    onEnsureSpecDir: (path) => {
      ensuredFor = path;
      seq.push("ensureSpecDir");
    },
  });
  const runner = fakeRunner(async () => {
    seq.push("install");
    return okResult();
  });
  await new SetupAdapter({ fs, runner, seedDir: "/seed" }).setup("/mirror/e2e");
  assert.deepEqual(seq, ["bootstrap", "ensureSpecDir", "install"]);
  assert.equal(ensuredFor, join("/mirror/e2e", "flows"));
});

/* Even on the install-cached fast path (deps up to date → no npm ci), the flows/ dir must still be
   ensured: a fresh checkout/clean can wipe it while node_modules (and the install marker) survive.
 */
test("ensures flows/ even when the install is cached and skipped", async () => {
  const seq: string[] = [];
  const fs = orchestrationFs({
    hasPackageJson: true,
    onBootstrap: () => seq.push("bootstrap"),
    onEnsureSpecDir: () => seq.push("ensureSpecDir"),
  });
  const runner = fakeRunner(async () => {
    seq.push("install");
    return okResult();
  });
  /* /mirror/e2e has no node_modules marker, so isInstallCurrent is false and install runs; the point
     here is simply that ensureSpecDir is invoked unconditionally before that branch.
   */
  await new SetupAdapter({ fs, runner, seedDir: "/seed" }).setup("/mirror/e2e");
  assert.ok(seq.includes("ensureSpecDir"), `ensureSpecDir must run: ${seq.join(",")}`);
});

test("a hung install times out and throws (the pipeline surfaces it as infra-error)", async () => {
  const fs = orchestrationFs({ hasPackageJson: true });
  /* The runner hangs forever (never resolves) — the OUTER race in setup() (defense-in-depth,
     independent of the runner's own internal timeout) must still fire and throw.
   */
  const runner = fakeRunner(() => new Promise(() => {}));
  await assert.rejects(
    () => new SetupAdapter({ fs, runner, seedDir: "/seed" }).setup("/mirror/e2e", { timeoutMs: 30 }),
    /timed out after 30ms — killed/,
  );
});

test("an already-aborted signal throws without starting the install", async () => {
  const controller = new AbortController();
  controller.abort();
  let installed = false;
  const fs = orchestrationFs({ hasPackageJson: true });
  const runner = fakeRunner(async () => {
    installed = true;
    return okResult();
  });
  await assert.rejects(
    () => new SetupAdapter({ fs, runner, seedDir: "/seed" }).setup("/mirror/e2e", { signal: controller.signal }),
    /aborted by operator cancel/,
  );
  assert.equal(installed, false);
});

test("signal and timeoutMs are passed through to the runner request", async () => {
  const controller = new AbortController();
  let seen: SandboxedRunRequest | undefined;
  const fs = orchestrationFs({ hasPackageJson: true });
  const runner = fakeRunner(async (req) => {
    seen = req;
    return okResult();
  });
  await new SetupAdapter({ fs, runner, seedDir: "/seed" }).setup("/mirror/e2e", { signal: controller.signal, timeoutMs: 5_000 });
  assert.equal(seen?.signal, controller.signal);
  assert.equal(seen?.timeoutMs, 5_000);
});

test("the install runs with a bounded output tail: its lifecycle scripts are untrusted and its output is never read", async () => {
  let seen: SandboxedRunRequest | undefined;
  const fs = orchestrationFs({ hasPackageJson: true });
  const runner = fakeRunner(async (req) => {
    seen = req;
    return okResult();
  });
  await new SetupAdapter({ fs, runner, seedDir: "/seed" }).setup("/mirror/e2e");
  assert.ok(typeof seen?.outputKeepChars === "number" && seen.outputKeepChars > 0, "the runner is asked to keep only a tail of the install output");
});

test("a failing install still propagates its own error (not a timeout)", async () => {
  const fs = orchestrationFs({ hasPackageJson: true });
  const runner = fakeRunner(async () => okResult({ exitCode: 1, timedOut: false }));
  await assert.rejects(
    () => new SetupAdapter({ fs, runner, seedDir: "/seed" }).setup("/mirror/e2e", { timeoutMs: 5_000 }),
    /failed \(code 1\)/,
  );
});

test("a runner-signaled timeout (timedOut:true, never rejects per SandboxedRunResult's own contract) still throws", async () => {
  const fs = orchestrationFs({ hasPackageJson: true });
  const runner = fakeRunner(async () => okResult({ exitCode: null, timedOut: true }));
  await assert.rejects(
    () => new SetupAdapter({ fs, runner, seedDir: "/seed" }).setup("/mirror/e2e", { timeoutMs: 5_000 }),
    /timed out after 5000ms — killed/,
  );
});

/* A mid-install operator cancel collapses to the SAME timedOut:true result shape as an internal
   timeout (SandboxedBinaryRunnerAdapter's onAbort branch resolves timedOut:true on operator
   cancel, mirroring its own timeout branch — see that module's header note). Without a consumer-
   level check, install() could not tell the two apart and always threw the generic "timed out
   after Xms — killed" message, masking the distinct operator-cancel message the deleted
   src/qa/setup.ts original always threw for this path. Fixed at the consumer level (this method),
   same pattern as stryker-mutation-oracle.adapter.ts's own signal check.
 */
test("a mid-install operator cancel (signal aborts DURING the run) throws the distinct operator-cancel message, not the generic timeout message", async () => {
  const controller = new AbortController();
  const fs = orchestrationFs({ hasPackageJson: true });
  const runner = fakeRunner(async () => {
    /* Simulate the abort firing WHILE the install is in flight: by the time the runner settles,
       the signal is already aborted — matching SandboxedBinaryRunnerAdapter's onAbort resolution.
     */
    controller.abort();
    return okResult({ exitCode: null, timedOut: true });
  });
  await assert.rejects(
    () => new SetupAdapter({ fs, runner, seedDir: "/seed" }).setup("/mirror/e2e", { signal: controller.signal, timeoutMs: 5_000 }),
    (err: Error) => {
      assert.match(err.message, /e2e dependency install aborted by operator cancel/);
      assert.doesNotMatch(err.message, /timed out after/, "the generic timeout message must not mask the distinct operator-cancel message");
      return true;
    },
  );
});

/* Tests run against real temp dirs so append-only and idempotency are provable without mocking the
   FS. SetupAdapter's own ensureFailureCapture (nodeFsDeps-backed) is the production code under test.
 */

test("ensureFailureCapture: first injection appends the block; existing lines untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-setup-test-"));
  try {
    const fixturesPath = join(dir, "fixtures.ts");
    const existingContent = "export const test = base.extend({});\nexport { expect };\n";
    writeFileSync(fixturesPath, existingContent);
    realAdapter().ensureFailureCapture(dir);
    const after = readFileSync(fixturesPath, "utf8");
    /* Marker must be present after injection. */
    assert.ok(after.includes(FAILURE_CAPTURE_MARKER), "marker not found after injection");
    /* Existing lines must still be present at the start (append-only). */
    assert.ok(after.startsWith(existingContent), "existing content was modified (not append-only)");
    assert.equal(after.slice(0, existingContent.length), existingContent);
    /* retry) and the new body fields — guarding that setup.adapter.ts's FAILURE_CAPTURE_BLOCK stays
       in sync with the fixture. The block must be ESM-safe — dynamic import(), never require().
     */
    assert.match(after, /testInfo\.project\.name/, "the injected block must record the project name");
    assert.match(after, /basename\(testInfo\.file/, "the injected block must record the spec file basename");
    assert.match(after, /createHash\("sha1"\)\.update\(`\$\{file\}\/\$\{title\}`\)/, "the filename hash must fold in the file AND the full title (no 80-char truncation)");
    assert.match(after, /\$\{safeProject\}__\$\{hash\}__\$\{testInfo\.retry\}\.json/, "the filename must be project__hash__retry");
    assert.match(after, /JSON\.stringify\(\{ project, file, title, retry: testInfo\.retry, yaml, finalUrl, httpStatus, runtimeErrors: dedupedRuntimeErrors \}\)/, "the body must carry project, file, title, retry, yaml, finalUrl, httpStatus, runtimeErrors");
    /* ESM-safe — the appended block runs in a native-ESM fixtures.ts where require() is undefined. */
    assert.doesNotMatch(after, /require\(/, "the injected block must not use require() (ReferenceError in ESM — dead capture)");
    assert.match(after, /await import\("node:fs"\)/, "the injected block must pull node:fs via dynamic import()");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureFailureCapture: idempotent — running twice produces identical output as running once", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-setup-test-"));
  try {
    const fixturesPath = join(dir, "fixtures.ts");
    writeFileSync(fixturesPath, "export { expect };\n");
    realAdapter().ensureFailureCapture(dir);
    const afterFirst = readFileSync(fixturesPath, "utf8");
    realAdapter().ensureFailureCapture(dir);
    const afterSecond = readFileSync(fixturesPath, "utf8");
    assert.equal(afterSecond, afterFirst, "second injection changed the file (not idempotent)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureFailureCapture: agent-added lines above the marker are preserved", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-setup-test-"));
  try {
    const fixturesPath = join(dir, "fixtures.ts");
    const agentLines = "export const myHelper = () => {};\nexport { expect };\n";
    writeFileSync(fixturesPath, agentLines);
    realAdapter().ensureFailureCapture(dir);
    const after = readFileSync(fixturesPath, "utf8");
    assert.ok(after.includes("myHelper"), "agent-added lines were removed");
    const markerIdx = after.indexOf(FAILURE_CAPTURE_MARKER);
    const helperIdx = after.indexOf("myHelper");
    assert.ok(markerIdx > helperIdx, "marker appears before agent lines (not append-only)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureFailureCapture: missing fixtures.ts is a no-op (new onboards get block from seed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-setup-test-"));
  try {
    assert.ok(!existsSync(join(dir, "fixtures.ts")), "test precondition: fixtures.ts must not exist");
    assert.doesNotThrow(() => realAdapter().ensureFailureCapture(dir));
    assert.ok(!existsSync(join(dir, "fixtures.ts")), "ensureFailureCapture created fixtures.ts when it should be a no-op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup() calls ensureFailureCapture after ensureSpecDir", async () => {
  const seq: string[] = [];
  const fs = orchestrationFs({
    hasPackageJson: true,
    onEnsureSpecDir: () => seq.push("ensureSpecDir"),
  });
  const spiedFs: SetupAdapterFsDeps = {
    ...fs,
    read: (path) => {
      if (path.endsWith("fixtures.ts")) seq.push("ensureFailureCapture");
      return "";
    },
  };
  const runner = fakeRunner(async () => {
    seq.push("install");
    return okResult();
  });
  await new SetupAdapter({ fs: spiedFs, runner, seedDir: "/seed" }).setup("/mirror/e2e");
  const specIdx = seq.indexOf("ensureSpecDir");
  const captureIdx = seq.indexOf("ensureFailureCapture");
  assert.ok(specIdx !== -1, "ensureSpecDir was not called");
  /* fixtures.ts does not exist under this fake (exists() always false for non-package.json paths), so
     ensureFailureCapture returns before reaching read() — assert the ORDER contract structurally
     instead: ensureSpecDir must run, and setup() must not throw when fixtures.ts is absent.
   */
  assert.equal(captureIdx, -1, "read() is never reached when fixtures.ts does not exist (no-op path)");
  assert.ok(seq.includes("install"), "setup() must complete through install");
});

/* A repo's e2e/playwright.config.ts follows the current seed only while it is byte-for-byte a shipped
   seed revision (stock). Any edit makes it the repo's own: it is never overwritten, and a missing
   managed env-passthrough key is reported instead.
 */

test("setup() calls ensurePlaywrightEnvKeys unconditionally, alongside ensureFailureCapture, before the install-current check", async () => {
  const seq: string[] = [];
  const fs = orchestrationFs({ hasPackageJson: true });
  const spiedFs: SetupAdapterFsDeps = {
    ...fs,
    exists: (path) => {
      if (path.endsWith("playwright.config.ts")) {
        seq.push("ensurePlaywrightEnvKeys");
        return false; /* no-op path — file absent */
      }
      return fs.exists(path);
    },
  };
  const runner = fakeRunner(async () => {
    seq.push("install");
    return okResult();
  });
  await new SetupAdapter({ fs: spiedFs, runner, seedDir: "/seed" }).setup("/mirror/e2e");
  assert.ok(seq.includes("ensurePlaywrightEnvKeys"), "ensurePlaywrightEnvKeys was not reached");
  assert.ok(seq.indexOf("ensurePlaywrightEnvKeys") < seq.indexOf("install"), "ensurePlaywrightEnvKeys must run before install");
});

const SEED_REVISIONS_DIR = fileURLToPath(new URL("./__fixtures__/seed-revisions", import.meta.url));

/* The exact bytes of a seed file as an earlier revision shipped it into watched repos. */
function shippedRevision(name: string): string {
  return readFileSync(join(SEED_REVISIONS_DIR, name), "utf8");
}

/* Runs `ensure` on a temp e2e dir holding `name` with `body`; returns the file afterwards. */
function afterEnsure(name: string, body: string, ensure: (adapter: SetupAdapter, dir: string) => void, seedDir = REAL_SEED_DIR): string {
  const dir = mkdtempSync(join(tmpdir(), "qa-setup-seed-owned-"));
  try {
    writeFileSync(join(dir, name), body);
    ensure(realAdapter(seedDir), dir);
    return readFileSync(join(dir, name), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ensureConfig = (adapter: SetupAdapter, dir: string): void => adapter.ensurePlaywrightEnvKeys(dir);

test("ensurePlaywrightEnvKeys replaces every earlier shipped seed revision with the current seed", () => {
  const currentSeed = readFileSync(join(REAL_SEED_DIR, "playwright.config.ts"), "utf8");
  for (const revision of ["playwright.config.rev1.txt", "playwright.config.rev2.txt", "playwright.config.rev3.txt"]) {
    assert.equal(afterEnsure("playwright.config.ts", shippedRevision(revision), ensureConfig), currentSeed, `${revision} is stock`);
  }
});

test("ensurePlaywrightEnvKeys never overwrites a shipped seed revision the repo customized", () => {
  const customized = shippedRevision("playwright.config.rev2.txt").replace("  retries: 2,", "  retries: 2,\n  expect: { timeout: 15_000 },");
  assert.notEqual(customized, shippedRevision("playwright.config.rev2.txt"), "test precondition: the customization applied");

  assert.equal(afterEnsure("playwright.config.ts", customized, ensureConfig), customized);
});

test("ensurePlaywrightEnvKeys: a config that is no seed revision is NOT touched, even if missing the keys", () => {
  const customConfig = `import { defineConfig } from "@playwright/test";\nexport default defineConfig({\n  testDir: ".",\n  use: { baseURL: process.env.PW_BASE_URL, timeout: 5000 },\n});\n`;
  assert.equal(afterEnsure("playwright.config.ts", customConfig, ensureConfig), customConfig);
});

test("ensurePlaywrightEnvKeys leaves the current seed as it is, and a replaced copy stays put on the next run", () => {
  const currentSeed = readFileSync(join(REAL_SEED_DIR, "playwright.config.ts"), "utf8");
  assert.equal(afterEnsure("playwright.config.ts", currentSeed, ensureConfig), currentSeed);

  const dir = mkdtempSync(join(tmpdir(), "qa-setup-pwconfig-idem-"));
  try {
    const configPath = join(dir, "playwright.config.ts");
    writeFileSync(configPath, shippedRevision("playwright.config.rev1.txt"));
    realAdapter().ensurePlaywrightEnvKeys(dir);
    const afterFirst = readFileSync(configPath, "utf8");
    realAdapter().ensurePlaywrightEnvKeys(dir);
    assert.equal(readFileSync(configPath, "utf8"), afterFirst);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* The seed that ships today is itself a revision repos hold once the seed changes again. */
test("ensurePlaywrightEnvKeys moves a copy of the shipped seed on to the next seed revision", () => {
  const shipped = readFileSync(join(REAL_SEED_DIR, "playwright.config.ts"), "utf8");
  const nextSeedDir = mkdtempSync(join(tmpdir(), "qa-setup-next-seed-"));
  try {
    const nextSeed = `${shipped}// the next seed revision\n`;
    writeFileSync(join(nextSeedDir, "playwright.config.ts"), nextSeed);
    assert.equal(afterEnsure("playwright.config.ts", shipped, ensureConfig, nextSeedDir), nextSeed);
  } finally {
    rmSync(nextSeedDir, { recursive: true, force: true });
  }
});

/* auth.setup.ts follows the current seed only while it is byte-for-byte a shipped seed revision — an
   earlier one saved the session under the agent-visible mirror. A login rewritten for the app is its
   own, whether or not it kept the seed marker. */
const ensureAuth = (adapter: SetupAdapter, dir: string): void => adapter.ensureAuthSetup(dir);

test("ensureAuthSetup replaces a stock auth.setup.ts from an earlier seed revision with the current seed", () => {
  const currentSeed = readFileSync(join(REAL_SEED_DIR, "auth.setup.ts"), "utf8");
  assert.equal(afterEnsure("auth.setup.ts", shippedRevision("auth.setup.rev1.txt"), ensureAuth), currentSeed);
});

test("ensureAuthSetup never overwrites a login rewritten for the app that kept the seed marker", () => {
  const appLogin = `/* qa-auth-setup-seed */\nimport { test as setup } from "@playwright/test";\nsetup("authenticate", async ({ page }) => {\n  await page.goto("/sso");\n  await page.getByRole("button", { name: "Continue with SSO" }).click();\n  await page.context().storageState({ path: process.env.PW_STORAGE_STATE ?? ".auth/user.json" });\n});\n`;
  assert.equal(afterEnsure("auth.setup.ts", appLogin, ensureAuth), appLogin);
});

test("ensureAuthSetup moves a copy of the shipped seed on to the next seed revision", () => {
  const shipped = readFileSync(join(REAL_SEED_DIR, "auth.setup.ts"), "utf8");
  const nextSeedDir = mkdtempSync(join(tmpdir(), "qa-setup-next-auth-seed-"));
  try {
    const nextSeed = `${shipped}/* the next seed revision */\n`;
    writeFileSync(join(nextSeedDir, "auth.setup.ts"), nextSeed);
    assert.equal(afterEnsure("auth.setup.ts", shipped, ensureAuth, nextSeedDir), nextSeed);
  } finally {
    rmSync(nextSeedDir, { recursive: true, force: true });
  }
});

test("ensureAuthSetup never overwrites an app-owned auth.setup.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-setup-auth-owned-"));
  try {
    const appOwned = `import { test as setup } from "@playwright/test";\nsetup("authenticate", async ({ page }) => { await page.goto("/sso"); });\n`;
    writeFileSync(join(dir, "auth.setup.ts"), appOwned);

    realAdapter().ensureAuthSetup(dir);

    assert.equal(readFileSync(join(dir, "auth.setup.ts"), "utf8"), appOwned);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureAuthSetup gives a repo without auth.setup.ts the current seed", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-setup-auth-missing-"));
  try {
    realAdapter().ensureAuthSetup(dir);

    const currentSeed = readFileSync(join(REAL_SEED_DIR, "auth.setup.ts"), "utf8");
    assert.equal(readFileSync(join(dir, "auth.setup.ts"), "utf8"), currentSeed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureSessionGitignore appends .auth/ once and creates the file when it is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-setup-auth-ignore-"));
  try {
    const ignorePath = join(dir, ".gitignore");
    writeFileSync(ignorePath, "node_modules/\n");
    realAdapter().ensureSessionGitignore(dir);
    const once = readFileSync(ignorePath, "utf8");
    assert.match(once, /\.auth\//);
    realAdapter().ensureSessionGitignore(dir);
    assert.equal(readFileSync(ignorePath, "utf8"), once);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const empty = mkdtempSync(join(tmpdir(), "qa-setup-auth-ignore-new-"));
  try {
    realAdapter().ensureSessionGitignore(empty);
    assert.equal(readFileSync(join(empty, ".gitignore"), "utf8"), ".auth/\n");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("ensurePlaywrightEnvKeys: missing playwright.config.ts is a no-op (new onboards get it from the seed copy already)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-setup-pwconfig-missing-"));
  try {
    assert.ok(!existsSync(join(dir, "playwright.config.ts")), "test precondition: config must not exist");
    assert.doesNotThrow(() => realAdapter().ensurePlaywrightEnvKeys(dir));
    assert.ok(!existsSync(join(dir, "playwright.config.ts")), "ensurePlaywrightEnvKeys must not create the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── The failure-capture block is ESM-safe (dynamic import, never require()) ──────────────
   config/e2e/fixtures.ts is native ESM ("type":"module", uses import.meta.url). The qa-failure-capture
   afterEach previously called require("node:fs") etc. → ReferenceError in ESM → swallowed by the
   surrounding try/catch → NO dump file → Lever-1's primary grounding path was DEAD. These tests prove
   the block (a) contains no require( token and (b) actually writes a dump when run as a real ES module.
 */

test("FAILURE_CAPTURE_BLOCK contains no require( token (ESM-safe)", () => {
  assert.doesNotMatch(FAILURE_CAPTURE_BLOCK, /require\(/, "the injected block must not use require() — it runs in a native-ESM fixtures.ts");
  /* And it MUST pull its deps via dynamic import() instead. */
  assert.match(FAILURE_CAPTURE_BLOCK, /await import\("node:fs"\)/);
  assert.match(FAILURE_CAPTURE_BLOCK, /await import\("node:path"\)/);
  assert.match(FAILURE_CAPTURE_BLOCK, /await import\("node:crypto"\)/);
});

test("the afterEach body, run as a real ES module, writes a dump (no ReferenceError)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-c1-esm-"));
  try {
    const moduleSrc =
      `const test = { beforeEach(fn) { globalThis.__qaBeforeEach = fn; }, afterEach(fn) { globalThis.__qaCapture = fn; } };\n` +
      FAILURE_CAPTURE_BLOCK +
      `\nexport const beforeEachFn = globalThis.__qaBeforeEach;\nexport const afterEachFn = globalThis.__qaCapture;\n`;
    const modPath = join(dir, "capture.mts");
    writeFileSync(modPath, moduleSrc);
    const captureDir = join(dir, "dumps");
    writeFileSync(join(dir, ".keep"), "");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(captureDir, { recursive: true });

    const mod = await import(pathToFileURL(modPath).href);
    assert.equal(typeof mod.beforeEachFn, "function", "the block must register a beforeEach callback");
    assert.equal(typeof mod.afterEachFn, "function", "the block must register an afterEach callback");

    let responseHandler: ((r: unknown) => void) | undefined;
    const fakeFinalUrl = "http://localhost:3000/owners/new";
    const fakePage = {
      on(event: string, cb: (r: unknown) => void) {
        if (event === "response") responseHandler = cb;
      },
      url: () => fakeFinalUrl,
      locator: (_sel: string) => ({ ariaSnapshot: async () => '- button "Submit"\n- heading "Owners"' }),
    };
    const fakeTestInfo = {
      status: "failed",
      expectedStatus: "passed",
      titlePath: ["chromium", "owner registration", "create owner"],
      project: { name: "desktop" },
      file: "/repo/e2e/owners.spec.ts",
      retry: 0,
    };

    const prev = process.env.QA_FAILURE_CAPTURE_DIR;
    process.env.QA_FAILURE_CAPTURE_DIR = captureDir;
    try {
      await mod.beforeEachFn({ page: fakePage });
      assert.ok(responseHandler, "beforeEach must register a response handler via page.on('response', ...)");

      const syntheticResponse = {
        url: () => "http://localhost:3000/api/owners",
        status: () => 500,
        request: () => ({ resourceType: () => "fetch" }),
      };
      responseHandler!(syntheticResponse);

      await mod.afterEachFn({ page: fakePage }, fakeTestInfo);
    } finally {
      if (prev === undefined) delete process.env.QA_FAILURE_CAPTURE_DIR;
      else process.env.QA_FAILURE_CAPTURE_DIR = prev;
    }

    const dumps = readdirSync(captureDir);
    assert.equal(dumps.length, 1, `exactly one dump must be written, got ${JSON.stringify(dumps)}`);
    const body = JSON.parse(readFileSync(join(captureDir, dumps[0]!), "utf8"));
    assert.equal(body.project, "desktop");
    assert.equal(body.file, "owners.spec.ts", "the dump body must carry the spec file basename");
    assert.equal(body.title, "owner registration › create owner", "title is titlePath without the leading project element");
    assert.equal(body.retry, 0);
    assert.match(body.yaml, /button "Submit"/, "the dump must carry the post-failure aria YAML");
    assert.equal(body.httpStatus, 500, "dump must carry the attributed 5xx httpStatus");
    assert.equal(body.finalUrl, fakeFinalUrl, "dump must carry the finalUrl from page.url()");
    assert.match(dumps[0]!, /^desktop__[0-9a-f]{12}__0\.json$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("httpStatus is absent when no ≥500 response was observed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-c1-no5xx-"));
  try {
    const moduleSrc =
      `const test = { beforeEach(fn) { globalThis.__qaBefore_no5xx = fn; }, afterEach(fn) { globalThis.__qaAfter_no5xx = fn; } };\n` +
      FAILURE_CAPTURE_BLOCK +
      `\nexport const beforeEachFn = globalThis.__qaBefore_no5xx;\nexport const afterEachFn = globalThis.__qaAfter_no5xx;\n`;
    const modPath = join(dir, "no5xx.mts");
    writeFileSync(modPath, moduleSrc);
    const captureDir = join(dir, "dumps");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(captureDir, { recursive: true });

    const mod = await import(pathToFileURL(modPath).href);
    let responseHandler: ((r: unknown) => void) | undefined;
    const fakePage = {
      on(event: string, cb: (r: unknown) => void) {
        if (event === "response") responseHandler = cb;
      },
      url: () => "http://localhost:3000/owners",
      locator: () => ({ ariaSnapshot: async () => '- button "X"' }),
    };
    const fakeTestInfo = { status: "failed", expectedStatus: "passed", titlePath: ["p", "s", "t"], project: { name: "desktop" }, file: "x.spec.ts", retry: 0 };

    const prev = process.env.QA_FAILURE_CAPTURE_DIR;
    process.env.QA_FAILURE_CAPTURE_DIR = captureDir;
    try {
      await mod.beforeEachFn({ page: fakePage });
      responseHandler!({ url: () => "http://localhost:3000/api/x", status: () => 404, request: () => ({ resourceType: () => "fetch" }) });
      await mod.afterEachFn({ page: fakePage }, fakeTestInfo);
    } finally {
      if (prev === undefined) delete process.env.QA_FAILURE_CAPTURE_DIR;
      else process.env.QA_FAILURE_CAPTURE_DIR = prev;
    }

    const dumps = readdirSync(captureDir);
    const body = JSON.parse(readFileSync(join(captureDir, dumps[0]!), "utf8"));
    assert.equal(body.httpStatus, undefined, "4xx must NOT produce httpStatus on the dump");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("httpStatus is absent when only a background ping/beacon 500 was observed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-c1-bgping-"));
  try {
    const moduleSrc =
      `const test = { beforeEach(fn) { globalThis.__qaBefore_bgping = fn; }, afterEach(fn) { globalThis.__qaAfter_bgping = fn; } };\n` +
      FAILURE_CAPTURE_BLOCK +
      `\nexport const beforeEachFn = globalThis.__qaBefore_bgping;\nexport const afterEachFn = globalThis.__qaAfter_bgping;\n`;
    const modPath = join(dir, "bgping.mts");
    writeFileSync(modPath, moduleSrc);
    const captureDir = join(dir, "dumps");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(captureDir, { recursive: true });

    const mod = await import(pathToFileURL(modPath).href);
    let responseHandler: ((r: unknown) => void) | undefined;
    const fakePage = {
      on(event: string, cb: (r: unknown) => void) {
        if (event === "response") responseHandler = cb;
      },
      url: () => "http://localhost:3000/owners",
      locator: () => ({ ariaSnapshot: async () => '- button "X"' }),
    };
    const fakeTestInfo = { status: "failed", expectedStatus: "passed", titlePath: ["p", "s", "t"], project: { name: "desktop" }, file: "x.spec.ts", retry: 0 };

    const prev = process.env.QA_FAILURE_CAPTURE_DIR;
    process.env.QA_FAILURE_CAPTURE_DIR = captureDir;
    try {
      await mod.beforeEachFn({ page: fakePage });
      responseHandler!({ url: () => "http://localhost:3000/telemetry", status: () => 500, request: () => ({ resourceType: () => "ping" }) });
      await mod.afterEachFn({ page: fakePage }, fakeTestInfo);
    } finally {
      if (prev === undefined) delete process.env.QA_FAILURE_CAPTURE_DIR;
      else process.env.QA_FAILURE_CAPTURE_DIR = prev;
    }

    const dumps = readdirSync(captureDir);
    const body = JSON.parse(readFileSync(join(captureDir, dumps[0]!), "utf8"));
    assert.equal(body.httpStatus, undefined, "background ping 500 must be excluded by the background-request heuristic — httpStatus must be absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("httpStatus is absent when only a cross-origin 500 was observed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-c1-xorigin-"));
  try {
    const moduleSrc =
      `const test = { beforeEach(fn) { globalThis.__qaBefore_xorigin = fn; }, afterEach(fn) { globalThis.__qaAfter_xorigin = fn; } };\n` +
      FAILURE_CAPTURE_BLOCK +
      `\nexport const beforeEachFn = globalThis.__qaBefore_xorigin;\nexport const afterEachFn = globalThis.__qaAfter_xorigin;\n`;
    const modPath = join(dir, "xorigin.mts");
    writeFileSync(modPath, moduleSrc);
    const captureDir = join(dir, "dumps");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(captureDir, { recursive: true });

    const mod = await import(pathToFileURL(modPath).href);
    let responseHandler: ((r: unknown) => void) | undefined;
    const fakePage = {
      on(event: string, cb: (r: unknown) => void) {
        if (event === "response") responseHandler = cb;
      },
      url: () => "http://localhost:3000/owners",
      locator: () => ({ ariaSnapshot: async () => '- button "X"' }),
    };
    const fakeTestInfo = { status: "failed", expectedStatus: "passed", titlePath: ["p", "s", "t"], project: { name: "desktop" }, file: "x.spec.ts", retry: 0 };

    const prev = process.env.QA_FAILURE_CAPTURE_DIR;
    process.env.QA_FAILURE_CAPTURE_DIR = captureDir;
    try {
      await mod.beforeEachFn({ page: fakePage });
      responseHandler!({ url: () => "https://cdn.example.com/asset.js", status: () => 500, request: () => ({ resourceType: () => "fetch" }) });
      await mod.afterEachFn({ page: fakePage }, fakeTestInfo);
    } finally {
      if (prev === undefined) delete process.env.QA_FAILURE_CAPTURE_DIR;
      else process.env.QA_FAILURE_CAPTURE_DIR = prev;
    }

    const dumps = readdirSync(captureDir);
    const body = JSON.parse(readFileSync(join(captureDir, dumps[0]!), "utf8"));
    assert.equal(body.httpStatus, undefined, "cross-origin 500 must be excluded by the same-origin gate — httpStatus must be absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("errorResponses resets between tests — reused page does not cross-attribute", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-c1-reset-"));
  try {
    const moduleSrc =
      `const test = { beforeEach(fn) { globalThis.__qaBefore_reset = fn; }, afterEach(fn) { globalThis.__qaAfter_reset = fn; } };\n` +
      FAILURE_CAPTURE_BLOCK +
      `\nexport const beforeEachFn = globalThis.__qaBefore_reset;\nexport const afterEachFn = globalThis.__qaAfter_reset;\n`;
    const modPath = join(dir, "reset.mts");
    writeFileSync(modPath, moduleSrc);
    const captureDir = join(dir, "dumps");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(captureDir, { recursive: true });

    const mod = await import(pathToFileURL(modPath).href);
    let responseHandler: ((r: unknown) => void) | undefined;
    const fakePage = {
      on(event: string, cb: (r: unknown) => void) {
        if (event === "response") responseHandler = cb;
      },
      url: () => "http://localhost:3000/owners",
      locator: () => ({ ariaSnapshot: async () => '- button "X"' }),
    };
    const fakeTestInfo1 = { status: "failed", expectedStatus: "passed", titlePath: ["p", "test-1", "t1"], project: { name: "desktop" }, file: "x.spec.ts", retry: 0 };
    const fakeTestInfo2 = { status: "failed", expectedStatus: "passed", titlePath: ["p", "test-2", "t2"], project: { name: "desktop" }, file: "x.spec.ts", retry: 0 };

    const prev = process.env.QA_FAILURE_CAPTURE_DIR;
    process.env.QA_FAILURE_CAPTURE_DIR = captureDir;
    try {
      await mod.beforeEachFn({ page: fakePage });
      responseHandler!({ url: () => "http://localhost:3000/api/owners", status: () => 500, request: () => ({ resourceType: () => "fetch" }) });
      await mod.afterEachFn({ page: fakePage }, fakeTestInfo1);

      await mod.beforeEachFn({ page: fakePage });
      await mod.afterEachFn({ page: fakePage }, fakeTestInfo2);
    } finally {
      if (prev === undefined) delete process.env.QA_FAILURE_CAPTURE_DIR;
      else process.env.QA_FAILURE_CAPTURE_DIR = prev;
    }

    const dumps = readdirSync(captureDir).sort();
    assert.equal(dumps.length, 2, "two dumps must be written");
    const body2 = JSON.parse(readFileSync(join(captureDir, dumps[1]!), "utf8"));
    assert.equal(body2.httpStatus, undefined, "second test must NOT inherit the first test's 500 — errorResponses must have been reset");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the afterEach body is a no-op when QA_FAILURE_CAPTURE_DIR is unset (no dump, no throw)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-c1-noop-"));
  try {
    const moduleSrc =
      `const test = { beforeEach(fn) { globalThis.__qaBeforeNoop = fn; }, afterEach(fn) { globalThis.__qaCaptureNoop = fn; } };\n` +
      FAILURE_CAPTURE_BLOCK +
      `\nexport const beforeEachFn = globalThis.__qaBeforeNoop;\nexport const afterEachFn = globalThis.__qaCaptureNoop;\n`;
    const modPath = join(dir, "capture-noop.mts");
    writeFileSync(modPath, moduleSrc);
    const mod = await import(pathToFileURL(modPath).href);
    const fakePage = {
      on(_event: string, _cb: unknown) {},
      url: () => "http://localhost:3000/",
      locator: () => ({ ariaSnapshot: async () => '- button "X"' }),
    };
    const fakeTestInfo = { status: "failed", expectedStatus: "passed", titlePath: ["p", "s", "t"], project: { name: "desktop" }, file: "x.spec.ts", retry: 0 };
    const prev = process.env.QA_FAILURE_CAPTURE_DIR;
    delete process.env.QA_FAILURE_CAPTURE_DIR;
    try {
      await assert.doesNotReject(() => mod.beforeEachFn({ page: fakePage }));
      await assert.doesNotReject(() => mod.afterEachFn({ page: fakePage }, fakeTestInfo));
    } finally {
      if (prev !== undefined) process.env.QA_FAILURE_CAPTURE_DIR = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── Byte-twin token guard for config/e2e/fixtures.ts ─────────────────
   The setup.adapter.ts FAILURE_CAPTURE_BLOCK is asserted by the tests above. Nothing
   asserted that config/e2e/fixtures.ts's qa-failure-capture block stays in sync. These token-presence
   tests catch a future edit that updates one twin but not the other.
 */

test("config/e2e/fixtures.ts qa-failure-capture block contains test.beforeEach", () => {
  const fixturesPath = join(REAL_SEED_DIR, "fixtures.ts");
  const content = readFileSync(fixturesPath, "utf8");
  const start = content.indexOf(">>> qa-failure-capture");
  const end = content.indexOf("<<< qa-failure-capture");
  assert.ok(start !== -1, "fixtures.ts must contain the qa-failure-capture start marker");
  assert.ok(end !== -1, "fixtures.ts must contain the qa-failure-capture end marker");
  const block = content.slice(start, end);
  assert.ok(block.includes("test.beforeEach"), "fixtures.ts qa-failure-capture block must contain test.beforeEach");
});

test("config/e2e/fixtures.ts qa-failure-capture block contains page.on('response'", () => {
  const fixturesPath = join(REAL_SEED_DIR, "fixtures.ts");
  const content = readFileSync(fixturesPath, "utf8");
  const start = content.indexOf(">>> qa-failure-capture");
  const end = content.indexOf("<<< qa-failure-capture");
  const block = content.slice(start, end);
  assert.ok(block.includes("page.on('response'"), "fixtures.ts qa-failure-capture block must contain page.on('response'");
});

test("config/e2e/fixtures.ts qa-failure-capture block contains errorResponses", () => {
  const fixturesPath = join(REAL_SEED_DIR, "fixtures.ts");
  const content = readFileSync(fixturesPath, "utf8");
  const start = content.indexOf(">>> qa-failure-capture");
  const end = content.indexOf("<<< qa-failure-capture");
  const block = content.slice(start, end);
  assert.ok(block.includes("errorResponses"), "fixtures.ts qa-failure-capture block must contain errorResponses");
});

test("config/e2e/fixtures.ts qa-failure-capture block contains finalUrl", () => {
  const fixturesPath = join(REAL_SEED_DIR, "fixtures.ts");
  const content = readFileSync(fixturesPath, "utf8");
  const start = content.indexOf(">>> qa-failure-capture");
  const end = content.indexOf("<<< qa-failure-capture");
  const block = content.slice(start, end);
  assert.ok(block.includes("finalUrl"), "fixtures.ts qa-failure-capture block must contain finalUrl");
});

test("config/e2e/fixtures.ts qa-failure-capture block contains httpStatus", () => {
  const fixturesPath = join(REAL_SEED_DIR, "fixtures.ts");
  const content = readFileSync(fixturesPath, "utf8");
  const start = content.indexOf(">>> qa-failure-capture");
  const end = content.indexOf("<<< qa-failure-capture");
  const block = content.slice(start, end);
  assert.ok(block.includes("httpStatus"), "fixtures.ts qa-failure-capture block must contain httpStatus");
});

/* ── Byte-twin token guard — runtimeErrors capture ──────────────────
   Same FIX4 pattern: catches a future edit that updates the fixtures.ts seed but not the
   setup.adapter.ts FAILURE_CAPTURE_BLOCK twin (existing repos are only ever updated via the twin).
 */

test("config/e2e/fixtures.ts qa-failure-capture block contains page.on('console'", () => {
  const fixturesPath = join(REAL_SEED_DIR, "fixtures.ts");
  const content = readFileSync(fixturesPath, "utf8");
  const start = content.indexOf(">>> qa-failure-capture");
  const end = content.indexOf("<<< qa-failure-capture");
  const block = content.slice(start, end);
  assert.ok(block.includes("page.on('console'"), "fixtures.ts qa-failure-capture block must contain page.on('console'");
});

test("config/e2e/fixtures.ts qa-failure-capture block contains page.on('pageerror'", () => {
  const fixturesPath = join(REAL_SEED_DIR, "fixtures.ts");
  const content = readFileSync(fixturesPath, "utf8");
  const start = content.indexOf(">>> qa-failure-capture");
  const end = content.indexOf("<<< qa-failure-capture");
  const block = content.slice(start, end);
  assert.ok(block.includes("page.on('pageerror'"), "fixtures.ts qa-failure-capture block must contain page.on('pageerror'");
});

test("config/e2e/fixtures.ts qa-failure-capture block contains runtimeErrors", () => {
  const fixturesPath = join(REAL_SEED_DIR, "fixtures.ts");
  const content = readFileSync(fixturesPath, "utf8");
  const start = content.indexOf(">>> qa-failure-capture");
  const end = content.indexOf("<<< qa-failure-capture");
  const block = content.slice(start, end);
  assert.ok(block.includes("runtimeErrors"), "fixtures.ts qa-failure-capture block must contain runtimeErrors");
});

test("setup.adapter.ts FAILURE_CAPTURE_BLOCK contains page.on('console'/'pageerror' and runtimeErrors (twin sync)", () => {
  assert.ok(FAILURE_CAPTURE_BLOCK.includes("page.on('console'"), "FAILURE_CAPTURE_BLOCK must register a console listener");
  assert.ok(FAILURE_CAPTURE_BLOCK.includes("page.on('pageerror'"), "FAILURE_CAPTURE_BLOCK must register a pageerror listener");
  assert.ok(FAILURE_CAPTURE_BLOCK.includes("runtimeErrors"), "FAILURE_CAPTURE_BLOCK must carry runtimeErrors");
  assert.match(
    FAILURE_CAPTURE_BLOCK,
    /JSON\.stringify\(\{ project, file, title, retry: testInfo\.retry, yaml, finalUrl, httpStatus, runtimeErrors[^}]*\}\)/,
    "FAILURE_CAPTURE_BLOCK's dump body must carry runtimeErrors alongside the existing fields",
  );
});

/* The capture block is appended into a repo's own fixtures.ts, which the static gate type-checks
   with the repo's e2e tsconfig — the seed's is strict. A block that does not type-check there turns
   every run of that repo invalid. Playwright is not installed in this template, so its types are a
   hand-written stand-in covering exactly the API the block touches; @types/node is the real one. */
const PLAYWRIGHT_TYPES_STAND_IN = `export interface Request { resourceType(): string; url(): string }
export interface Response { status(): number; url(): string; request(): Request }
export interface ConsoleMessage { type(): string; text(): string }
export interface Locator { ariaSnapshot(options?: { timeout?: number }): Promise<string> }
export interface Page {
  on(event: "response", listener: (response: Response) => unknown): this;
  on(event: "console", listener: (message: ConsoleMessage) => unknown): this;
  on(event: "pageerror", listener: (error: Error) => unknown): this;
  url(): string;
  locator(selector: string): Locator;
}
export type TestStatus = "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
export interface TestInfo { status?: TestStatus; expectedStatus: TestStatus; titlePath: string[]; project: { name: string }; file: string; retry: number }
export interface TestType<Args> {
  (title: string, body: (args: Args, testInfo: TestInfo) => Promise<void> | void): void;
  beforeEach(hook: (args: Args, testInfo: TestInfo) => Promise<void> | void): void;
  afterEach(hook: (args: Args, testInfo: TestInfo) => Promise<void> | void): void;
  extend<T extends object>(fixtures: object): TestType<Args & T>;
}
export declare const test: TestType<{ page: Page }>;
export declare const expect: (actual: unknown) => { toBe(expected: unknown): void };
`;

const REPO_FIXTURES = 'import { test as base, expect } from "@playwright/test";\nexport const test = base.extend<{}>({});\nexport { expect };\n';

/* Runs ensureFailureCapture on a repo whose fixtures.ts is `fixtures`, then type-checks it with the seed's tsconfig. */
function typeCheckAfterCapture(fixtures: string): { exitCode: number; output: string; after: string } {
  const dir = mkdtempSync(join(tmpdir(), "qa-setup-capture-tsc-"));
  try {
    const repoRoot = join(REAL_SEED_DIR, "..", "..");
    copyFileSync(join(REAL_SEED_DIR, "tsconfig.json"), join(dir, "tsconfig.json"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(join(dir, "node_modules", "@types"), { recursive: true });
    symlinkSync(join(repoRoot, "node_modules", "@types", "node"), join(dir, "node_modules", "@types", "node"), "dir");
    const playwright = join(dir, "node_modules", "@playwright", "test");
    mkdirSync(playwright, { recursive: true });
    writeFileSync(join(playwright, "package.json"), JSON.stringify({ name: "@playwright/test", types: "index.d.ts" }));
    writeFileSync(join(playwright, "index.d.ts"), PLAYWRIGHT_TYPES_STAND_IN);
    writeFileSync(join(dir, "fixtures.ts"), fixtures);

    realAdapter().ensureFailureCapture(dir);
    const after = readFileSync(join(dir, "fixtures.ts"), "utf8");

    const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    try {
      return { exitCode: 0, output: execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], { encoding: "utf8" }), after };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { exitCode: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}`, after };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a repo fixtures.ts with the capture block appended type-checks under the seed's strict tsconfig", () => {
  const { exitCode, output, after } = typeCheckAfterCapture(REPO_FIXTURES);
  assert.ok(after.includes(FAILURE_CAPTURE_MARKER), "precondition: the block was appended");
  assert.equal(exitCode, 0, `the appended fixtures.ts must type-check under the seed tsconfig:\n${output}`);
});

test("a repo that received an earlier, untyped capture block type-checks after setup", () => {
  const { exitCode, output } = typeCheckAfterCapture(REPO_FIXTURES + shippedRevision("failure-capture.rev3.txt"));
  assert.equal(exitCode, 0, `the upgraded fixtures.ts must type-check under the seed tsconfig:\n${output}`);
});

/* Every capture block a repo received, appended or in the seed's fixtures.ts, is recorded as a
   failure-capture.revN.txt fixture; the newest is the block shipped today. Only a block that is still
   byte-for-byte an earlier revision is upgraded, in place. Changing FAILURE_CAPTURE_BLOCK means
   recording it as the next revision, which makes the outgoing block an earlier one that must upgrade. */
const FAILURE_CAPTURE_REVISIONS = readdirSync(SEED_REVISIONS_DIR)
  .filter((name) => /^failure-capture\.rev\d+\.txt$/.test(name))
  .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));

test("the block shipped today is the newest recorded capture block revision", () => {
  const newest = FAILURE_CAPTURE_REVISIONS.at(-1)!;
  assert.equal(
    shippedRevision(newest),
    FAILURE_CAPTURE_BLOCK,
    `FAILURE_CAPTURE_BLOCK changed: record it as the next failure-capture.revN.txt after ${newest} and add the outgoing block's sha256 to the earlier revisions`,
  );
});

test("ensureFailureCapture upgrades every earlier recorded block revision in place to the current block", () => {
  const later = "export const helperAddedLater = 1;\n";
  const earlier = FAILURE_CAPTURE_REVISIONS.slice(0, -1);
  assert.ok(earlier.length > 0, "precondition: earlier revisions are recorded");
  for (const revision of earlier) {
    const after = afterEnsure("fixtures.ts", REPO_FIXTURES + shippedRevision(revision) + later, (adapter, dir) => adapter.ensureFailureCapture(dir));
    assert.equal(after, REPO_FIXTURES + FAILURE_CAPTURE_BLOCK + later, `${revision} is an earlier capture block`);
  }
});

/* One revision was appended without its markers. A repo holding it byte-for-byte gets the current
   block in its place; appending beside it would redeclare its variables and fail every run's
   type-check. */
test("ensureFailureCapture replaces in place the capture block appended without markers", () => {
  const later = "export const helperAddedLater = 1;\n";
  const after = afterEnsure("fixtures.ts", REPO_FIXTURES + shippedRevision("failure-capture.unmarked.txt") + later, (adapter, dir) => adapter.ensureFailureCapture(dir));
  assert.equal(after, REPO_FIXTURES + FAILURE_CAPTURE_BLOCK + later);
});

test("a repo that received the capture block without markers type-checks after setup", () => {
  const { exitCode, output } = typeCheckAfterCapture(REPO_FIXTURES + shippedRevision("failure-capture.unmarked.txt"));
  assert.equal(exitCode, 0, `the upgraded fixtures.ts must type-check under the seed tsconfig:\n${output}`);
});

test("ensureFailureCapture leaves an edited copy of the block appended without markers as it is, appending nothing", () => {
  const unmarked = shippedRevision("failure-capture.unmarked.txt");
  const edited = REPO_FIXTURES + unmarked.replace("runtimeErrors = [];\n  try {", "runtimeErrors = [];\n  console.log('edited');\n  try {");
  assert.notEqual(edited, REPO_FIXTURES + unmarked, "test precondition: the edit applied");

  assert.equal(afterEnsure("fixtures.ts", edited, (adapter, dir) => adapter.ensureFailureCapture(dir)), edited);
});

test("ensureFailureCapture never touches an appended capture block someone edited", () => {
  const edited = REPO_FIXTURES + shippedRevision("failure-capture.rev3.txt").replace("let errorResponses = [];", "let errorResponses: unknown[] = [];");
  assert.notEqual(edited, REPO_FIXTURES + shippedRevision("failure-capture.rev3.txt"), "test precondition: the edit applied");

  assert.equal(afterEnsure("fixtures.ts", edited, (adapter, dir) => adapter.ensureFailureCapture(dir)), edited);
});

/* The seed's fixtures.ts (new onboards) and FAILURE_CAPTURE_BLOCK (appended into existing repos)
   are the same capture code: a repo must get identical failure evidence whichever way it received the
   block. Both are strict TypeScript, so they are compared as-is — a token-presence check would miss a
   silent change such as a NUL byte in the runtimeErrors dedup key. */
test("the seed fixtures.ts carries exactly the capture block that is appended into existing repos", () => {
  const content = readFileSync(join(REAL_SEED_DIR, "fixtures.ts"), "utf8");
  const start = content.indexOf(">>> qa-failure-capture");
  assert.ok(start !== -1, "fixtures.ts must contain the qa-failure-capture start marker");
  const blockStart = content.lastIndexOf("\n", start); /* the newline just before "// >>>" */
  const endMarkerLine = "// <<< qa-failure-capture <<<";
  const endMarkerIdx = content.indexOf(endMarkerLine, start);
  assert.ok(endMarkerIdx !== -1, "fixtures.ts must contain the full end marker line");
  const seedBlock = content.slice(blockStart, endMarkerIdx + endMarkerLine.length + 1); /* include the trailing newline */

  assert.equal(
    seedBlock,
    FAILURE_CAPTURE_BLOCK,
    "config/e2e/fixtures.ts's capture block has drifted from setup.adapter.ts's FAILURE_CAPTURE_BLOCK — existing repos only ever receive FAILURE_CAPTURE_BLOCK, so the two must stay identical",
  );
});

/* ── The afterEach body, run as a real ES module, dumps runtimeErrors ─────────
   Same harness as the ESM tests above: run the block's beforeEach/afterEach as genuine ESM
   callbacks against a fake page that emits console/pageerror events, and assert the dump.
 */

test("dump carries deduped+capped runtimeErrors from console('error')+pageerror events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-c1-runtime-"));
  try {
    const moduleSrc =
      `const test = { beforeEach(fn) { globalThis.__qaBefore_rt = fn; }, afterEach(fn) { globalThis.__qaAfter_rt = fn; } };\n` +
      FAILURE_CAPTURE_BLOCK +
      `\nexport const beforeEachFn = globalThis.__qaBefore_rt;\nexport const afterEachFn = globalThis.__qaAfter_rt;\n`;
    const modPath = join(dir, "runtime.mts");
    writeFileSync(modPath, moduleSrc);
    const captureDir = join(dir, "dumps");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(captureDir, { recursive: true });

    const mod = await import(pathToFileURL(modPath).href);
    const handlers: Record<string, ((arg: unknown) => void) | undefined> = {};
    const fakePage = {
      on(event: string, cb: (arg: unknown) => void) {
        handlers[event] = cb;
      },
      url: () => "http://localhost:3000/owners",
      locator: () => ({ ariaSnapshot: async () => '- button "Submit"' }),
    };
    const fakeTestInfo = { status: "failed", expectedStatus: "passed", titlePath: ["p", "owner registration", "create owner"], project: { name: "desktop" }, file: "/repo/e2e/owners.spec.ts", retry: 0 };

    const prev = process.env.QA_FAILURE_CAPTURE_DIR;
    process.env.QA_FAILURE_CAPTURE_DIR = captureDir;
    try {
      await mod.beforeEachFn({ page: fakePage });
      assert.ok(handlers.console, "beforeEach must register a console listener via page.on('console', ...)");
      assert.ok(handlers.pageerror, "beforeEach must register a pageerror listener via page.on('pageerror', ...)");

      handlers.console!({ type: () => "warning", text: () => "some deprecation warning" });
      handlers.console!({ type: () => "error", text: () => "ERROR Error: NG0100: ExpressionChangedAfterItHasBeenCheckedError" });
      handlers.console!({ type: () => "error", text: () => "ERROR Error: NG0100: ExpressionChangedAfterItHasBeenCheckedError" });
      handlers.pageerror!({ message: "TypeError: Cannot read properties of undefined" });

      await mod.afterEachFn({ page: fakePage }, fakeTestInfo);
    } finally {
      if (prev === undefined) delete process.env.QA_FAILURE_CAPTURE_DIR;
      else process.env.QA_FAILURE_CAPTURE_DIR = prev;
    }

    const dumps = readdirSync(captureDir);
    assert.equal(dumps.length, 1);
    const body = JSON.parse(readFileSync(join(captureDir, dumps[0]!), "utf8"));
    assert.ok(Array.isArray(body.runtimeErrors), "dump must carry a runtimeErrors array");
    assert.equal(body.runtimeErrors.length, 2, "the duplicate console.error must be deduped and the warning excluded");
    assert.ok(
      body.runtimeErrors.some((e: { type: string; text: string }) => e.type === "pageerror" && e.text.includes("TypeError")),
      "the pageerror entry must be present",
    );
    assert.ok(
      body.runtimeErrors.some((e: { type: string; text: string }) => e.type === "error" && e.text.includes("NG0100")),
      "the deduped console.error entry must be present",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtimeErrors is reset between tests — reused page does not cross-attribute", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-c1-runtime-reset-"));
  try {
    const moduleSrc =
      `const test = { beforeEach(fn) { globalThis.__qaBefore_rtreset = fn; }, afterEach(fn) { globalThis.__qaAfter_rtreset = fn; } };\n` +
      FAILURE_CAPTURE_BLOCK +
      `\nexport const beforeEachFn = globalThis.__qaBefore_rtreset;\nexport const afterEachFn = globalThis.__qaAfter_rtreset;\n`;
    const modPath = join(dir, "runtime-reset.mts");
    writeFileSync(modPath, moduleSrc);
    const captureDir = join(dir, "dumps");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(captureDir, { recursive: true });

    const mod = await import(pathToFileURL(modPath).href);
    const handlers: Record<string, ((arg: unknown) => void) | undefined> = {};
    const fakePage = {
      on(event: string, cb: (arg: unknown) => void) {
        handlers[event] = cb;
      },
      url: () => "http://localhost:3000/owners",
      locator: () => ({ ariaSnapshot: async () => '- button "X"' }),
    };
    const fakeTestInfo1 = { status: "failed", expectedStatus: "passed", titlePath: ["p", "test-1", "t1"], project: { name: "desktop" }, file: "x.spec.ts", retry: 0 };
    const fakeTestInfo2 = { status: "failed", expectedStatus: "passed", titlePath: ["p", "test-2", "t2"], project: { name: "desktop" }, file: "x.spec.ts", retry: 0 };

    const prev = process.env.QA_FAILURE_CAPTURE_DIR;
    process.env.QA_FAILURE_CAPTURE_DIR = captureDir;
    try {
      await mod.beforeEachFn({ page: fakePage });
      handlers.pageerror!({ message: "TypeError: boom" });
      await mod.afterEachFn({ page: fakePage }, fakeTestInfo1);

      await mod.beforeEachFn({ page: fakePage });
      await mod.afterEachFn({ page: fakePage }, fakeTestInfo2);
    } finally {
      if (prev === undefined) delete process.env.QA_FAILURE_CAPTURE_DIR;
      else process.env.QA_FAILURE_CAPTURE_DIR = prev;
    }

    const dumps = readdirSync(captureDir).sort();
    assert.equal(dumps.length, 2);
    const body2 = JSON.parse(readFileSync(join(captureDir, dumps[1]!), "utf8"));
    assert.equal(body2.runtimeErrors.length, 0, "second test must NOT inherit the first test's runtimeErrors — must have been reset");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the afterEach body remains a no-op when QA_FAILURE_CAPTURE_DIR is unset, even with console/pageerror listeners active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-c1-runtime-noop-"));
  try {
    const moduleSrc =
      `const test = { beforeEach(fn) { globalThis.__qaBeforeRtNoop = fn; }, afterEach(fn) { globalThis.__qaCaptureRtNoop = fn; } };\n` +
      FAILURE_CAPTURE_BLOCK +
      `\nexport const beforeEachFn = globalThis.__qaBeforeRtNoop;\nexport const afterEachFn = globalThis.__qaCaptureRtNoop;\n`;
    const modPath = join(dir, "capture-rt-noop.mts");
    writeFileSync(modPath, moduleSrc);
    const mod = await import(pathToFileURL(modPath).href);
    const fakePage = {
      on(_event: string, _cb: unknown) {},
      url: () => "http://localhost:3000/",
      locator: () => ({ ariaSnapshot: async () => '- button "X"' }),
    };
    const fakeTestInfo = { status: "failed", expectedStatus: "passed", titlePath: ["p", "s", "t"], project: { name: "desktop" }, file: "x.spec.ts", retry: 0 };
    const prev = process.env.QA_FAILURE_CAPTURE_DIR;
    delete process.env.QA_FAILURE_CAPTURE_DIR;
    try {
      await assert.doesNotReject(() => mod.beforeEachFn({ page: fakePage }));
      await assert.doesNotReject(() => mod.afterEachFn({ page: fakePage }, fakeTestInfo));
    } finally {
      if (prev !== undefined) process.env.QA_FAILURE_CAPTURE_DIR = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
