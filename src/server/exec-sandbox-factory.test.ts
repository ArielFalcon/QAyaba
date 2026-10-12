import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExecWiring, buildScriptExec, suiteAccountFor } from "./exec-sandbox-factory";
import { SandboxUnavailableError } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox";
import { newSandboxReport } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope";

const ENV = { DEV_TEST_USER: "default-user", DEV_TEST_PASS: "default-pass", QA_APP_USER: "declared-user", QA_APP_PASS: "declared-pass" };

test("a spec gets no account unless its app opted in", () => {
  assert.equal(suiteAccountFor({}, ENV), undefined);
  assert.equal(suiteAccountFor({ e2e: { specCredentials: "none" } }, ENV), undefined);
});

test("an opted-in app hands its specs the account its auth declaration names, else the conventional one", () => {
  assert.deepEqual(suiteAccountFor({ e2e: { specCredentials: "account" }, auth: { usernameEnv: "QA_APP_USER", passwordEnv: "QA_APP_PASS" } }, ENV), { user: "declared-user", pass: "declared-pass" });
  assert.deepEqual(suiteAccountFor({ e2e: { specCredentials: "account" } }, ENV), { user: "default-user", pass: "default-pass" });
});

test("opting in without an account in the environment hands nothing", () => {
  assert.equal(suiteAccountFor({ e2e: { specCredentials: "account" } }, {}), undefined);
});

/* The launchers the service and the operator scripts build both ask the boot check's status before a spawn: a wiring that forgot it would run agent code on a host whose files are open. */
test("the run's and the scripts' launchers refuse agent code when the boot check found the file boundary open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-factory-"));
  try {
    const status = join(dir, "files.status");
    writeFileSync(status, "breach: /app/src is writable by the sandbox uid\n");
    const env: NodeJS.ProcessEnv = { QA_EXEC_SANDBOX: "required", QA_EGRESS_MODE: "warn", QA_FILE_BOUNDARY_STATUS_FILE: status, QA_EXEC_ROOT: join(dir, "exec") };
    const sandbox = { uid: process.getuid?.() ?? 1002, gid: process.getgid?.() ?? 1002, home: dir };
    const scope = { runId: "r", workDir: dir, egress: { dev: [], install: [] }, report: newSandboxReport() };
    const refusesForFiles = (err: unknown): boolean => err instanceof SandboxUnavailableError && err.reason === "files" && /\/app\/src is writable/.test(err.message);
    const run = buildExecWiring({ env, sandbox, authDir: dir, egressOrigins: { dev: [], install: [] } });
    assert.throws(() => run.exec.spawn("true", [], { cwd: dir, profile: "offline", scope }), refusesForFiles);
    const script = buildScriptExec(env, sandbox);
    assert.throws(() => script.exec.spawn("true", [], { cwd: dir, profile: "offline", scope }), refusesForFiles);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
