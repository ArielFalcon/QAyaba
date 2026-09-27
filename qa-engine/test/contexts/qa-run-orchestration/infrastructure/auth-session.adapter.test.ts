import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthSessionAdapter } from "@contexts/qa-run-orchestration/infrastructure/auth-session.adapter.ts";

const SEED = "/* qa-auth-setup-seed */\nexport {};\n";

function authDirFixture(): string {
  return mkdtempSync(join(tmpdir(), "auth-dir-"));
}

test("absent auth returns an empty session and does not spawn", async () => {
  let spawned = false;
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  const adapter = new AuthSessionAdapter({
    env: {},
    seedAuthSetup: SEED,
    authDir: authDirFixture(),
    spawnSetup: async () => { spawned = true; return { exitCode: 0, logs: "" }; },
  });
  const session = await adapter.prepare({ specDir, baseUrl: "https://dev.example", phase: "pre-generate" });
  assert.equal(spawned, false);
  assert.deepEqual(session, { unauthored: false });
});

/* Batch S / S2: the agents container mounts the mirrors volume (read+bash) but not qa-data, so
   auth material must live in the orchestrator-only authDir, never under the watched-repo mirror
   (specDir). */
test("mtls decodes the base64 P12 to authDir/client.p12 — NEVER under the mirror (specDir)", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  const authDir = authDirFixture();
  const adapter = new AuthSessionAdapter({
    env: { QA_CERT: Buffer.from("p12-bytes").toString("base64"), QA_CERT_PASS: "secret" },
    seedAuthSetup: SEED,
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
    seedAuthSetup: SEED,
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
    seedAuthSetup: SEED,
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
    seedAuthSetup: SEED,
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
    seedAuthSetup: SEED,
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
  assert.equal(session.storageStatePath, join(authDir, "user.json"));
  assert.equal(capturedEnv.PW_STORAGE_STATE, join(authDir, "user.json"), "the setup project must be told to write outside the mirror");
  assert.equal(existsSync(session.storageStatePath!), true);
  assert.equal(session.unauthored, false);
  assert.equal(statSync(session.storageStatePath!).mode & 0o777, 0o600);
  assert.equal(existsSync(join(specDir, ".auth")), false, "must never write auth material under the mirror");
});

test("mtls without a passphrase throws", async () => {
  const adapter = new AuthSessionAdapter({
    env: { QA_CERT: Buffer.from("p12-bytes").toString("base64") },
    seedAuthSetup: SEED,
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
    seedAuthSetup: SEED,
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

test("a seed marker still counts as stock after the seed text changes", async () => {
  const specDir = mkdtempSync(join(tmpdir(), "auth-"));
  writeFileSync(join(specDir, "auth.setup.ts"), "/* qa-auth-setup-seed */\nexport const revised = true;\n");
  const adapter = new AuthSessionAdapter({
    env: { QA_USER: "u", QA_PASS: "p" },
    seedAuthSetup: SEED,
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
});
