/* The environment a sandboxed child receives is built from an explicit allowlist per profile, never from the orchestrator's own environment minus a blocklist: what a profile does not name does not exist for the child. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExecEnv, SANDBOX_PROFILES, type ExecEnvInput } from "../../../src/shared-infrastructure/process-sandbox/exec-env.ts";

const SECRETS: NodeJS.ProcessEnv = {
  PATH: "/usr/local/bin:/usr/bin",
  LANG: "C.UTF-8",
  HOME: "/root",
  PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
  GITHUB_TOKEN: "ghp_orchestrator",
  QA_API_TOKEN: "api-token",
  QA_TOOLS_TOKEN: "tools-token",
  WEBHOOK_SECRET: "hook",
  OPENCODE_API_KEY: "oc-key",
  OPENCODE_SERVER_PASSWORD: "oc-pass",
  CODEX_API_KEY: "cx-key",
  DOPPLER_TOKEN: "dp",
  DEV_TEST_USER: "orchestrator-user",
  DEV_TEST_PASS: "orchestrator-pass",
  DEV_ENV_USER: "gate-user-from-env",
  DEV_ENV_PASS: "gate-pass-from-env",
  DEV_CLIENT_CERT_PASS: "cert-from-env",
  NODE_OPTIONS: "--require /app/evil.js",
  NODE_PATH: "/app/node_modules",
  npm_config_registry: "https://registry.npmjs.org/",
  npm_config_cache: "/root/.npm",
  JAVA_HOME: "/usr/lib/jvm/default-java",
};

const SANDBOX = { uid: 1002, gid: 1002, home: "/home/sandbox" };

function input(profile: ExecEnvInput["profile"], more: Partial<ExecEnvInput> = {}): ExecEnvInput {
  return { profile, base: SECRETS, sandbox: SANDBOX, workDir: "/tmp/qa-exec/run-1", ...more };
}

const FORBIDDEN = ["GITHUB_TOKEN", "QA_API_TOKEN", "QA_TOOLS_TOKEN", "WEBHOOK_SECRET", "OPENCODE_API_KEY", "OPENCODE_SERVER_PASSWORD", "CODEX_API_KEY", "DOPPLER_TOKEN", "NODE_OPTIONS", "NODE_PATH"];

test("no profile ever hands the child an orchestrator secret, however the account and gate are supplied", () => {
  for (const profile of SANDBOX_PROFILES) {
    const env = buildExecEnv(input(profile, { account: { user: "acct", pass: "acct-pass" }, gateCreds: { user: "g", pass: "gp" } }));
    for (const key of FORBIDDEN) assert.equal(key in env, false, `${profile} leaked ${key}`);
    assert.equal(Object.values(env).some((value) => /ghp_orchestrator|api-token|tools-token|oc-pass|cx-key/.test(value)), false, `${profile} carries a secret value`);
  }
});

test("the child's home and temp dir are inside the run's work dir, never the orchestrator's and never one that outlives the run", () => {
  const env = buildExecEnv(input("suite"));
  assert.equal(env.HOME, "/tmp/qa-exec/run-1/home");
  assert.equal(env.TMPDIR, "/tmp/qa-exec/run-1/tmp");
  assert.equal(env.PATH, SECRETS.PATH);
});

test("only the login profile carries the test account", () => {
  const account = { user: "acct-user", pass: "acct-pass" };
  for (const profile of SANDBOX_PROFILES) {
    const env = buildExecEnv(input(profile, { account }));
    if (profile === "login") {
      assert.equal(env.DEV_TEST_USER, "acct-user");
      assert.equal(env.DEV_TEST_PASS, "acct-pass");
    } else {
      assert.equal("DEV_TEST_USER" in env, false, `${profile} got the account user`);
      assert.equal("DEV_TEST_PASS" in env, false, `${profile} got the account password`);
    }
  }
});

test("the orchestrator's own DEV_TEST_* variables never pass through, in any profile", () => {
  for (const profile of SANDBOX_PROFILES) {
    const env = buildExecEnv(input(profile));
    assert.equal("DEV_TEST_USER" in env, false);
    assert.equal("DEV_TEST_PASS" in env, false);
  }
});

test("the DEV gate credentials come from the run's scope, only to profiles that open pages", () => {
  const gateCreds = { user: "gate-u", pass: "gate-p" };
  assert.equal(buildExecEnv(input("suite", { gateCreds })).DEV_ENV_USER, "gate-u");
  assert.equal(buildExecEnv(input("suite", { gateCreds })).DEV_ENV_PASS, "gate-p");
  assert.equal(buildExecEnv(input("login", { gateCreds })).DEV_ENV_USER, "gate-u");
  for (const profile of ["offline", "install"] as const) {
    assert.equal("DEV_ENV_USER" in buildExecEnv(input(profile, { gateCreds })), false);
  }
  assert.equal("DEV_ENV_USER" in buildExecEnv(input("suite")), false, "the orchestrator's own DEV_ENV_USER is not forwarded");
});

test("a suite gets the staged session, a login never does (it produces one)", () => {
  const staged = { storageState: "/tmp/qa-exec/run-1/auth/user.json", clientCert: "/tmp/qa-exec/run-1/auth/client.p12", certPass: "pw-of-cert" };
  const suite = buildExecEnv(input("suite", { staged }));
  assert.equal(suite.PW_STORAGE_STATE, staged.storageState);
  assert.equal(suite.PW_CLIENT_CERT_PATH, staged.clientCert);
  assert.equal(suite.DEV_CLIENT_CERT_PASS, "pw-of-cert");
  const login = buildExecEnv(input("login", { staged, extraEnv: { PW_STORAGE_STATE: "/tmp/qa-exec/run-1/login/user.json" } }));
  assert.equal(login.PW_STORAGE_STATE, "/tmp/qa-exec/run-1/login/user.json");
  assert.equal(login.PW_CLIENT_CERT_PATH, staged.clientCert);
});

test("offline and install profiles never see a session or a certificate", () => {
  const staged = { storageState: "/s/user.json", clientCert: "/s/client.p12", certPass: "pw" };
  for (const profile of ["offline", "install"] as const) {
    const env = buildExecEnv(input(profile, { staged }));
    assert.equal("PW_STORAGE_STATE" in env, false);
    assert.equal("PW_CLIENT_CERT_PATH" in env, false);
    assert.equal("DEV_CLIENT_CERT_PASS" in env, false);
  }
});

test("a login's session file must be inside the run's work dir", () => {
  assert.throws(() => buildExecEnv(input("login", { extraEnv: { PW_STORAGE_STATE: "/app/data/auth/x/user.json" } })), /work dir/i);
});

test("the install profile keeps the toolchain and package-manager variables and rebases the cache under the run's home", () => {
  const env = buildExecEnv(input("install"));
  assert.equal(env.JAVA_HOME, "/usr/lib/jvm/default-java");
  assert.equal(env.npm_config_registry, "https://registry.npmjs.org/");
  assert.equal(env.npm_config_cache, "/tmp/qa-exec/run-1/home/.npm");
});

test("the suite profile does not carry the toolchain variables it does not need", () => {
  const env = buildExecEnv(input("suite"));
  assert.equal("JAVA_HOME" in env, false);
  assert.equal("npm_config_registry" in env, false);
});

test("extra variables are limited to the Playwright and capture contract, and cannot name a secret family", () => {
  const ok = buildExecEnv(input("suite", { extraEnv: { PW_BASE_URL: "https://dev.example", PW_NAMESPACE: "ns", PLAYWRIGHT_JSON_OUTPUT_NAME: "/tmp/qa-exec/run-1/report/r.json", QA_FAILURE_CAPTURE_DIR: "/tmp/qa-exec/run-1/failures" } }));
  assert.equal(ok.PW_BASE_URL, "https://dev.example");
  assert.equal(ok.PW_NAMESPACE, "ns");
  assert.throws(() => buildExecEnv(input("suite", { extraEnv: { GITHUB_TOKEN: "x" } })), /not allowed/);
  assert.throws(() => buildExecEnv(input("suite", { extraEnv: { DEV_TEST_PASS: "x" } })), /not allowed/);
  assert.throws(() => buildExecEnv(input("suite", { extraEnv: { NODE_OPTIONS: "--inspect" } })), /not allowed/);
});

test("without a sandbox identity the child keeps the caller's home but still gets the run's temp dir", () => {
  const env = buildExecEnv({ ...input("suite"), sandbox: null });
  assert.equal(env.HOME, "/root");
  assert.equal(env.TMPDIR, "/tmp/qa-exec/run-1/tmp");
});

test("a suite gets the account only when its app opted in, and then no other profile but login does either", () => {
  const suiteAccount = { user: "spec-user", pass: "spec-pass-1" };
  const optedIn = buildExecEnv(input("suite", { suiteAccount }));
  assert.equal(optedIn.DEV_TEST_USER, "spec-user");
  assert.equal(optedIn.DEV_TEST_PASS, "spec-pass-1");
  for (const profile of ["offline", "install"] as const) {
    assert.equal("DEV_TEST_PASS" in buildExecEnv(input(profile, { suiteAccount })), false, profile);
  }
  assert.equal("DEV_TEST_PASS" in buildExecEnv(input("suite")), false, "not opted in: no account");
});

test("the login profile's own account wins over the suite opt-in", () => {
  const env = buildExecEnv(input("login", { account: { user: "login-user", pass: "login-pass" }, suiteAccount: { user: "spec-user", pass: "spec-pass-1" } }));
  assert.equal(env.DEV_TEST_USER, "login-user");
});
