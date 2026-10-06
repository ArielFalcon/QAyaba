import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_SETUP_ENV, AuthSessionAdapter, type AuthSessionAdapterDeps } from "@contexts/qa-run-orchestration/infrastructure/auth-session.adapter.ts";
import { AUTH_MATERIAL_FILES, authSessionEnv } from "../../../../src/shared-infrastructure/process-sandbox/auth-session-env.ts";

/* The login seed as it ships today, and as an earlier revision shipped it into watched repos. */
const SEED = readFileSync(fileURLToPath(new URL("../../../../../config/e2e/auth.setup.ts", import.meta.url)), "utf8");
const EARLIER_SEED = readFileSync(
  fileURLToPath(new URL("../../workspace-and-publication/infrastructure/__fixtures__/seed-revisions/auth.setup.rev1.txt", import.meta.url)),
  "utf8",
);

function authDirFixture(): string {
  return mkdtempSync(join(tmpdir(), "auth-dir-"));
}

test("absent auth returns an empty session and does not spawn", async () => {
  let spawned = false;
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  const adapter = new AuthSessionAdapter({
    env: {},
    authDir: authDirFixture(),
    spawnSetup: async () => { spawned = true; return { exitCode: 0, logs: "" }; },
  });
  const session = await adapter.prepare({ specDir, baseUrl: "https://dev.example", phase: "pre-generate" });
  assert.equal(spawned, false);
  assert.deepEqual(session, { unauthored: false });
});

/* The agents container mounts the mirrors volume (read+bash) but not qa-data, so
   auth material must live in the orchestrator-only authDir, never under the watched-repo mirror
   (specDir). */
test("mtls decodes the base64 P12 to authDir/client.p12 — NEVER under the mirror (specDir)", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  const authDir = authDirFixture();
  const adapter = new AuthSessionAdapter({
    env: { QA_CERT: Buffer.from("p12-bytes").toString("base64"), QA_CERT_PASS: "secret" },
    authDir,
    spawnSetup: async () => { throw new Error("must not spawn"); },
  });
  const session = await adapter.prepare({
    specDir,
    baseUrl: "https://dev.example",
    phase: "pre-generate",
    auth: { kind: "mtls", certEnv: "QA_CERT", certPassEnv: "QA_CERT_PASS" },
  });
  assert.equal(session.clientCertPath, join(authDir, "client.p12"));
  assert.equal(readFileSync(session.clientCertPath!).toString(), "p12-bytes");
  assert.equal(readFileSync(join(authDir, "cert.pass"), "utf8"), "secret");
  assert.equal(session.unauthored, false);
  assert.equal(existsSync(join(specDir, ".auth")), false, "must never write auth material under the mirror");
});

test("form with missing username env throws", async () => {
  const adapter = new AuthSessionAdapter({
    env: {},
    authDir: authDirFixture(),
    spawnSetup: async () => ({ exitCode: 0, logs: "" }),
  });
  await assert.rejects(
    () => adapter.prepare({
      specDir: mkdtempSync(join(tmpdir(), "auth-")),
      baseUrl: "https://dev.example",
      phase: "pre-generate",
      auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" },
    }),
    /QA_USER/,
  );
});

test("stock seed login failure on pre-generate is unauthored and does not throw", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  writeFileSync(join(specDir, "auth.setup.ts"), SEED);
  const adapter = new AuthSessionAdapter({
    env: { QA_USER: "u", QA_PASS: "p" },
    authDir: authDirFixture(),
    spawnSetup: async () => ({ exitCode: 1, logs: "selector miss" }),
  });
  const session = await adapter.prepare({
    specDir,
    baseUrl: "https://dev.example",
    phase: "pre-generate",
    auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" },
  });
  assert.equal(session.unauthored, true);
  assert.equal(session.storageStatePath, undefined);
});

test("authored setup failure throws", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  writeFileSync(join(specDir, "auth.setup.ts"), "/* app-owned login */\n");
  const adapter = new AuthSessionAdapter({
    env: { QA_USER: "u", QA_PASS: "p" },
    authDir: authDirFixture(),
    spawnSetup: async () => ({ exitCode: 1, logs: "still on login" }),
  });
  await assert.rejects(
    () => adapter.prepare({
      specDir,
      baseUrl: "https://dev.example",
      phase: "pre-execute",
      auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" },
    }),
    /still on login/,
  );
});

test("successful form login returns the storageState path the spawn wrote, under authDir — NEVER under the mirror (specDir)", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  const authDir = authDirFixture();
  writeFileSync(join(specDir, "auth.setup.ts"), "/* app-owned login */\n");
  let capturedEnv: Record<string, string> = {};
  const adapter = new AuthSessionAdapter({
    env: { QA_USER: "u", QA_PASS: "p" },
    authDir,
    spawnSetup: async (_specDir, env) => {
      capturedEnv = env;
      /* Simulate Playwright's setup project honoring PW_STORAGE_STATE as the output path. */
      writeFileSync(env.PW_STORAGE_STATE!, "{\"cookies\":[]}");
      return { exitCode: 0, logs: "" };
    },
  });
  const session = await adapter.prepare({
    specDir,
    baseUrl: "https://dev.example",
    phase: "pre-execute",
    auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" },
  });
  assert.equal(session.storageStatePath, join(authDir, AUTH_MATERIAL_FILES.storageState));
  assert.equal(capturedEnv.PW_STORAGE_STATE, join(authDir, AUTH_MATERIAL_FILES.storageState), "the setup project must be told to write outside the mirror");
  assert.equal(existsSync(session.storageStatePath!), true);
  assert.equal(session.unauthored, false);
  assert.equal(statSync(session.storageStatePath!).mode & 0o777, 0o600);
  assert.equal(existsSync(join(specDir, ".auth")), false, "must never write auth material under the mirror");
});

test("mtls without a passphrase throws", async () => {
  const adapter = new AuthSessionAdapter({
    env: { QA_CERT: Buffer.from("p12-bytes").toString("base64") },
    authDir: authDirFixture(),
    spawnSetup: async () => { throw new Error("must not spawn"); },
  });
  await assert.rejects(
    () => adapter.prepare({
      specDir: mkdtempSync(join(tmpdir(), "auth-")),
      baseUrl: "https://dev.example",
      phase: "pre-generate",
      auth: { kind: "mtls", certEnv: "QA_CERT", certPassEnv: "QA_CERT_PASS" },
    }),
    /QA_CERT_PASS/,
  );
});

test("exit 0 without user.json throws on pre-execute", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  writeFileSync(join(specDir, "auth.setup.ts"), "/* app-owned login */\n");
  const adapter = new AuthSessionAdapter({
    env: { QA_USER: "u", QA_PASS: "p" },
    authDir: authDirFixture(),
    spawnSetup: async () => ({ exitCode: 0, logs: "" }),
  });
  await assert.rejects(
    () => adapter.prepare({
      specDir,
      baseUrl: "https://dev.example",
      phase: "pre-execute",
      auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" },
    }),
    /auth setup failed/,
  );
});

/* Only a byte-for-byte shipped seed is stock. A login the app wrote is its own even when it kept the
   seed's first-line marker, so its failing sign-in is an integration error, never an unauthored run
   that invites the generator to rewrite the login. */
test("a login the app wrote that kept the seed marker fails loudly when its sign-in fails before generation", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  const authDir = authDirFixture();
  try {
    writeFileSync(join(specDir, "auth.setup.ts"), `/* qa-auth-setup-seed */\nimport { test as setup } from "@playwright/test";\nsetup("authenticate", async ({ page }) => { await page.goto("/sso"); });\n`);
    const adapter = new AuthSessionAdapter({
      env: { QA_USER: "u", QA_PASS: "p" },
      authDir,
      spawnSetup: async () => ({ exitCode: 1, logs: "sso button not found" }),
    });
    await assert.rejects(
      () => adapter.prepare({
        specDir,
        baseUrl: "https://dev.example",
        phase: "pre-generate",
        auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" },
      }),
      /sso button not found/,
    );
  } finally {
    rmSync(specDir, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
  }
});

test("an earlier shipped seed revision that cannot log in before generation is unauthored", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  const authDir = authDirFixture();
  try {
    writeFileSync(join(specDir, "auth.setup.ts"), EARLIER_SEED);
    const adapter = new AuthSessionAdapter({
      env: { QA_USER: "u", QA_PASS: "p" },
      authDir,
      spawnSetup: async () => ({ exitCode: 1, logs: "selector miss" }),
    });
    const session = await adapter.prepare({
      specDir,
      baseUrl: "https://dev.example",
      phase: "pre-generate",
      auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" },
    });
    assert.equal(session.unauthored, true);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
  }
});

/* A session or certificate left by an earlier run (or an earlier auth declaration) must never stand in
   for this run's: what the env overlay injects is only what THIS prepare produced. */
const AUTH_ENV_KEYS = ["PW_STORAGE_STATE", "PW_CLIENT_CERT_PATH", "DEV_CLIENT_CERT_PASS"];

function authDirWithEarlierRunMaterial(): string {
  const dir = authDirFixture();
  writeFileSync(join(dir, AUTH_MATERIAL_FILES.storageState), "{\"cookies\":[{\"name\":\"from-an-earlier-run\"}]}");
  writeFileSync(join(dir, "client.p12"), "earlier-p12");
  writeFileSync(join(dir, "cert.pass"), "earlier-pass");
  return dir;
}

function injectedAuthKeys(authDir: string): string[] {
  const env = authSessionEnv(authDir, {});
  return AUTH_ENV_KEYS.filter((k) => k in env);
}

test("an authored form setup that exits 0 without writing a session fails instead of reusing an earlier run's session", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  const authDir = authDirWithEarlierRunMaterial();
  try {
    writeFileSync(join(specDir, "auth.setup.ts"), "/* app-owned login that ignores PW_STORAGE_STATE */\n");
    const adapter = new AuthSessionAdapter({
      env: { QA_USER: "u", QA_PASS: "p" },
      authDir,
      spawnSetup: async () => ({ exitCode: 0, logs: "" }),
    });
    await assert.rejects(
      () => adapter.prepare({
        specDir,
        baseUrl: "https://dev.example",
        phase: "pre-execute",
        auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" },
      }),
      /auth setup failed/,
    );
    assert.deepEqual(injectedAuthKeys(authDir), [], "no earlier-run material may reach the suite env");
  } finally {
    rmSync(specDir, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
  }
});

test("a stock seed that cannot log in before generation runs unauthenticated, not on an earlier run's session", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  const authDir = authDirWithEarlierRunMaterial();
  try {
    writeFileSync(join(specDir, "auth.setup.ts"), SEED);
    const adapter = new AuthSessionAdapter({
      env: { QA_USER: "u", QA_PASS: "p" },
      authDir,
      spawnSetup: async () => ({ exitCode: 1, logs: "selector miss" }),
    });
    const session = await adapter.prepare({
      specDir,
      baseUrl: "https://dev.example",
      phase: "pre-generate",
      auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" },
    });
    assert.equal(session.unauthored, true);
    assert.deepEqual(injectedAuthKeys(authDir), []);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
  }
});

test("an app with no auth declared gets no auth env from an earlier run's material", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  const authDir = authDirWithEarlierRunMaterial();
  try {
    const adapter = new AuthSessionAdapter({
      env: {},
      authDir,
      spawnSetup: async () => { throw new Error("must not spawn"); },
    });
    await adapter.prepare({ specDir, baseUrl: "https://dev.example", phase: "pre-generate" });
    assert.deepEqual(injectedAuthKeys(authDir), []);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
  }
});

test("a form login injects only its session, never an earlier client certificate", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  const authDir = authDirWithEarlierRunMaterial();
  try {
    writeFileSync(join(specDir, "auth.setup.ts"), "/* app-owned login */\n");
    const adapter = new AuthSessionAdapter({
      env: { QA_USER: "u", QA_PASS: "p" },
      authDir,
      spawnSetup: async (_dir, env) => {
        writeFileSync(env.PW_STORAGE_STATE!, "{\"cookies\":[]}");
        return { exitCode: 0, logs: "" };
      },
    });
    await adapter.prepare({
      specDir,
      baseUrl: "https://dev.example",
      phase: "pre-execute",
      auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" },
    });
    assert.deepEqual(injectedAuthKeys(authDir), ["PW_STORAGE_STATE"]);
    assert.equal(readFileSync(join(authDir, AUTH_MATERIAL_FILES.storageState), "utf8"), "{\"cookies\":[]}", "the session must be the one this login wrote");
  } finally {
    rmSync(specDir, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
  }
});

test("a client certificate injects only the certificate, never an earlier form session", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  const authDir = authDirWithEarlierRunMaterial();
  try {
    const adapter = new AuthSessionAdapter({
      env: { QA_CERT: Buffer.from("p12-bytes").toString("base64"), QA_CERT_PASS: "secret" },
      authDir,
      spawnSetup: async () => { throw new Error("must not spawn"); },
    });
    await adapter.prepare({
      specDir,
      baseUrl: "https://dev.example",
      phase: "pre-generate",
      auth: { kind: "mtls", certEnv: "QA_CERT", certPassEnv: "QA_CERT_PASS" },
    });
    assert.deepEqual(injectedAuthKeys(authDir), ["PW_CLIENT_CERT_PATH", "DEV_CLIENT_CERT_PASS"]);
    assert.equal(authSessionEnv(authDir, {}).DEV_CLIENT_CERT_PASS, "secret");
  } finally {
    rmSync(specDir, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
  }
});

/* The setup project runs the same seed playwright.config.ts as the suite, so it needs the app's
   test-id attribute and action timeout to resolve locators and bound its waits the way the suite does. */
async function setupSpawnEnv(deps: Partial<Pick<AuthSessionAdapterDeps, "testIdAttribute" | "actionTimeoutMs">>): Promise<Record<string, string>> {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  const authDir = authDirFixture();
  try {
    let capturedEnv: Record<string, string> = {};
    const adapter = new AuthSessionAdapter({
      env: { QA_USER: "u", QA_PASS: "p" },
      authDir,
      spawnSetup: async (_dir, env) => {
        capturedEnv = env;
        return { exitCode: 1, logs: "" };
      },
      ...deps,
    });
    await adapter.prepare({
      specDir,
      baseUrl: "https://dev.example",
      phase: "pre-generate",
      auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" },
    });
    return capturedEnv;
  } finally {
    rmSync(specDir, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
  }
}

test("the setup spawn receives the configured test-id attribute and action timeout", async () => {
  const env = await setupSpawnEnv({ testIdAttribute: "data-cy", actionTimeoutMs: "15000" });
  assert.equal(env[AUTH_SETUP_ENV.testIdAttribute], "data-cy");
  assert.equal(env[AUTH_SETUP_ENV.actionTimeoutMs], "15000");
});

test("the setup spawn carries neither name when the app configures neither", async () => {
  const env = await setupSpawnEnv({});
  assert.equal(AUTH_SETUP_ENV.testIdAttribute in env, false);
  assert.equal(AUTH_SETUP_ENV.actionTimeoutMs in env, false);
});

test("the test-id attribute and the action timeout are passed independently of each other", async () => {
  const onlyAttribute = await setupSpawnEnv({ testIdAttribute: "data-qa" });
  assert.equal(onlyAttribute[AUTH_SETUP_ENV.testIdAttribute], "data-qa");
  assert.equal(AUTH_SETUP_ENV.actionTimeoutMs in onlyAttribute, false);

  const onlyTimeout = await setupSpawnEnv({ actionTimeoutMs: "20000" });
  assert.equal(onlyTimeout[AUTH_SETUP_ENV.actionTimeoutMs], "20000");
  assert.equal(AUTH_SETUP_ENV.testIdAttribute in onlyTimeout, false);
});

/* An empty timeout would reach the seed config as Number("") = 0, which Playwright reads as "no
   action timeout"; an empty attribute would name no attribute at all. Neither is passed on. */
test("an empty test-id attribute or action timeout is not passed to the setup spawn", async () => {
  const env = await setupSpawnEnv({ testIdAttribute: "", actionTimeoutMs: "" });
  assert.equal(AUTH_SETUP_ENV.testIdAttribute in env, false);
  assert.equal(AUTH_SETUP_ENV.actionTimeoutMs in env, false);
});
