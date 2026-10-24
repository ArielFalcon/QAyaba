import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/* An operator script's suite lives in a throwaway copy under the mirrors volume, which boot closes to root: the scripts' launcher opens the mirror a child runs in to the sandbox group, as a run's does, or the sandbox uid cannot reach the suite it installs or runs. */
test("the scripts' launcher opens the mirror a child runs in to the sandbox group, and its scope closes that mirror and no other", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exec-factory-"));
  try {
    const mirrors = join(dir, "mirrors");
    const copy = join(mirrors, ".baseline", "label", "e2e");
    mkdirSync(copy, { recursive: true });
    const calls: string[] = [];
    const mirrorOps = {
      lstat: () => ({ isDirectory: () => true, uid: 0 }),
      readdir: () => [".baseline", "live-app"],
      chown: (path: string, uid: number, gid: number) => { calls.push(`chown ${path} ${uid}:${gid}`); },
      chmod: (path: string, mode: number) => { calls.push(`chmod ${path} ${mode.toString(8)}`); },
    };
    const env: NodeJS.ProcessEnv = { QA_EGRESS_MODE: "warn", QA_EXEC_ROOT: join(dir, "exec") };
    const sandbox = { uid: process.getuid?.() ?? 1002, gid: process.getgid?.() ?? 1002, home: dir };
    const script = buildScriptExec(env, sandbox, undefined, { mirrorRoot: mirrors, mirrorOps });
    await script.scoped({ runId: "r" }, async () => {
      const child = script.exec.spawn("true", [], { cwd: copy, profile: "offline" });
      await new Promise((resolve) => child.on("close", resolve));
    });
    const baseline = join(mirrors, ".baseline");
    assert.ok(calls.includes(`chown ${baseline} 0:${sandbox.gid}`), "the copy's mirror is opened to the sandbox group");
    assert.ok(calls.includes(`chown ${baseline} 0:0`), "the scope closes the mirror it opened");
    /* A live run may have its own mirror open beside the script: the script's scope never seals it. */
    assert.ok(!calls.some((c) => c.includes("live-app")), "another mirror is left as it is");
    assert.ok(!calls.includes(`chmod ${mirrors} 711`), "the script does not seal the whole volume");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
