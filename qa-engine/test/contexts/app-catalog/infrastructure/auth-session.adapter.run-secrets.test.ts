/* The adapter that logs in is the one place that holds every secret of the run's account at once: the login's, the DEV gate's, the certificate's, and the session the login produced. It registers them into the run it is part of, so nothing derived from the run reaches a model with one of them in it. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import { AuthSessionAdapter, type AuthSessionAdapterDeps } from "@contexts/app-catalog/infrastructure/auth-session.adapter.ts";
import { createRunSecretScope, redactByValue, withRunSecretScope } from "../../../../src/shared-infrastructure/redaction/run-secret-redaction.ts";

const dir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

function adapterWith(env: Record<string, string>, overrides: Partial<AuthSessionAdapterDeps> = {}): { adapter: AuthSessionAdapter; authDir: string } {
  const authDir = dir("auth-secrets-dir-");
  return { adapter: new AuthSessionAdapter({ env, authDir, spawnSetup: async () => ({ exitCode: 0, logs: "" }), ...overrides }), authDir };
}

const seen = (...texts: string[]): string => withRunSecretScope(scopeUnderTest, () => texts.map(redactByValue).join("|"));
let scopeUnderTest = createRunSecretScope();
const inRun = async <T>(run: () => Promise<T>): Promise<T> => {
  scopeUnderTest = createRunSecretScope();
  return withRunSecretScope(scopeUnderTest, run);
};

test("the DEV gate's credentials are registered even when the app declares no login", async () => {
  const { adapter } = adapterWith({ DEV_ENV_USER: "gate-user-name", DEV_ENV_PASS: "gate-pass-word", DEV_CLIENT_CERT_PASS: "cert-pass-phrase", UNRELATED: "unrelated-value" });
  await inRun(() => adapter.prepare({ specDir: dir("auth-spec-"), baseUrl: "https://dev.example", phase: "pre-generate" }));
  assert.equal(seen("gate-user-name gate-pass-word cert-pass-phrase unrelated-value"), `${REDACTED} ${REDACTED} ${REDACTED} unrelated-value`);
});

test("a certificate's passphrase is registered", async () => {
  const { adapter } = adapterWith({ QA_CERT: Buffer.from("p12-bytes").toString("base64"), QA_CERT_PASS: "p12-pass-phrase" });
  await inRun(() => adapter.prepare({ specDir: dir("auth-spec-"), baseUrl: "https://dev.example", phase: "pre-generate", auth: { kind: "mtls", certEnv: "QA_CERT", certPassEnv: "QA_CERT_PASS" } }));
  assert.equal(seen("p12-pass-phrase"), REDACTED);
});

test("a form login's password is registered, and so are the cookie and storage values of the session it wrote; its username is not a secret and stays readable", async () => {
  const { adapter } = adapterWith(
    { QA_USER: "qa-account-user", QA_PASS: "qa-account-pass" },
    {
      spawnSetup: async (_specDir, env) => {
        writeFileSync(env.PW_STORAGE_STATE!, JSON.stringify({ cookies: [{ name: "sid", value: "session-cookie-value" }], origins: [{ origin: "https://dev.example", localStorage: [{ name: "t", value: "storage-token-value" }] }] }));
        return { exitCode: 0, logs: "" };
      },
    },
  );
  const session = await inRun(() => adapter.prepare({ specDir: dir("auth-spec-"), baseUrl: "https://dev.example", phase: "pre-generate", auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" } }));
  assert.ok(session.storageStatePath);
  assert.equal(seen("qa-account-user qa-account-pass session-cookie-value storage-token-value"), ["qa-account-user", REDACTED, REDACTED, REDACTED].join(" "));
});

test("a login that fails still leaves its account secrets registered", async () => {
  const { adapter } = adapterWith({ QA_USER: "qa-account-user", QA_PASS: "qa-account-pass" }, { spawnSetup: async () => ({ exitCode: 1, logs: "boom" }) });
  await inRun(() => adapter.prepare({ specDir: dir("auth-spec-"), baseUrl: "https://dev.example", phase: "pre-execute", auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" } }).catch(() => undefined));
  assert.equal(seen("qa-account-pass"), REDACTED);
});

test("outside a run the adapter registers nothing and behaves as before", async () => {
  const { adapter } = adapterWith({ DEV_ENV_PASS: "gate-pass-word" });
  assert.deepEqual(await adapter.prepare({ specDir: dir("auth-spec-"), baseUrl: "https://dev.example", phase: "pre-generate" }), { unauthored: false });
  assert.equal(redactByValue("gate-pass-word"), "gate-pass-word");
});

test("an account name such as admin is left in the routes, DOM and assertions a model reads", async () => {
  const { adapter } = adapterWith({ QA_USER: "admin", QA_PASS: "correct-horse-battery" });
  await inRun(() => adapter.prepare({ specDir: dir("auth-spec-"), baseUrl: "https://dev.example", phase: "pre-generate", auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" } }));
  assert.equal(seen("goto /admin/users as admin"), "goto /admin/users as admin");
});
