/* A run's sandbox scope: its work dir exists for the run alone, the egress filter is prepared for the run's origins before its first child, and the mirrors volume is sealed to root when the scope opens and when it ends. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecScopeProvider } from "../../../src/shared-infrastructure/process-sandbox/exec-scope-provider.ts";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import { createRunSecretScope, redactByValue, withRunSecretScope } from "../../../src/shared-infrastructure/run-secret-redaction.ts";
import { SandboxResidueError } from "../../../src/shared-infrastructure/process-sandbox/sandbox-reaper.ts";
import { isSandboxUnavailable } from "../../../src/shared-infrastructure/process-sandbox/exec-sandbox.ts";
import { activeExecScope } from "../../../src/shared-infrastructure/process-sandbox/exec-scope.ts";
import type { MirrorFsOps } from "../../../src/shared-infrastructure/process-sandbox/mirror-access.ts";

const SELF = { uid: process.getuid?.() ?? 1002, gid: process.getgid?.() ?? 1002, home: "/home/sandbox" };

function recordingOps(log: string[]): MirrorFsOps {
  return {
    lstat: () => ({ isDirectory: () => true, uid: 0 }),
    readdir: () => ["org__a"],
    chown: (path, uid, gid) => { log.push(`chown ${path} ${uid}:${gid}`); },
    chmod: (path, mode) => { log.push(`chmod ${path} ${mode.toString(8)}`); },
  };
}

test("the scope's work dir exists while the run is in it and is gone when it ends", async () => {
  const root = mkdtempSync(join(tmpdir(), "scope-provider-"));
  try {
    const session = await createExecScopeProvider({ workRoot: root, sandbox: null, egress: { dev: [], install: [] } }).open({ runId: "run-1" });
    const workDir = session.run(() => activeExecScope()?.workDir);
    assert.equal(workDir, join(root, "run-1"));
    assert.equal(existsSync(workDir!), true);
    session.close();
    assert.equal(existsSync(workDir!), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the egress filter is prepared for every origin the run declares, before the scope is handed out", async () => {
  const root = mkdtempSync(join(tmpdir(), "scope-provider-"));
  const prepared: string[][] = [];
  try {
    const provider = createExecScopeProvider({
      workRoot: root,
      sandbox: null,
      egress: { dev: ["https://dev.example.com"], install: ["https://registry.npmjs.org"] },
      egressGate: { mode: "enforce", available: () => true, prepare: async (origins) => { prepared.push([...origins]); }, lease: () => ({ release: () => {} }) },
    });
    const session = await provider.open({ runId: "run-2" });
    assert.deepEqual(prepared, [["https://dev.example.com", "https://registry.npmjs.org"]]);
    session.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the mirrors are sealed when the scope opens and when it ends, so none stays open to the sandbox group", async () => {
  const root = mkdtempSync(join(tmpdir(), "scope-provider-"));
  const log: string[] = [];
  try {
    const provider = createExecScopeProvider({ workRoot: root, sandbox: SELF, mirrorRoot: "/m", mirrorOps: recordingOps(log), egress: { dev: [], install: [] } });
    const session = await provider.open({ runId: "run-3" });
    assert.ok(log.includes("chmod /m/org__a 750"), "sealed on open");
    const afterOpen = log.length;
    session.close();
    assert.ok(log.length > afterOpen && log.slice(afterOpen).includes("chown /m/org__a 0:0"), "sealed again on close");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a mirror that cannot be sealed is said, not thrown into the run", async () => {
  const root = mkdtempSync(join(tmpdir(), "scope-provider-"));
  try {
    const failing: MirrorFsOps = { lstat: () => { throw new Error("EIO"); }, readdir: () => ["x"], chown: () => {}, chmod: () => { throw new Error("EIO"); } };
    const session = await createExecScopeProvider({ workRoot: root, sandbox: SELF, mirrorRoot: "/m", mirrorOps: failing, egress: { dev: [], install: [] } }).open({ runId: "run-4" });
    session.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the spec account's password is a secret of the run from the moment its scope is entered; its username is not", async () => {
  const root = mkdtempSync(join(tmpdir(), "scope-provider-"));
  try {
    const provider = createExecScopeProvider({ workRoot: root, sandbox: null, egress: { dev: [], install: [] }, suiteAccount: { user: "admin", pass: "spec-pass-1" } });
    const session = await provider.open({ runId: "run-secrets" });
    const scope = createRunSecretScope();
    const redacted = withRunSecretScope(scope, () => session.run(() => redactByValue("admin signs in with spec-pass-1")));
    session.close();
    assert.equal(redacted, `admin signs in with ${REDACTED}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run starts only when nothing of an earlier run is left running under the sandbox uid, and ends the same way", async () => {
  const root = mkdtempSync(join(tmpdir(), "scope-provider-"));
  const reaps: string[] = [];
  try {
    const provider = createExecScopeProvider({ workRoot: root, sandbox: SELF, egress: { dev: [], install: [] }, reaper: { reapOrphans: () => { reaps.push(existsSync(join(root, "run-9")) ? "work dir present" : "work dir absent"); return 0; } } });
    const session = await provider.open({ runId: "run-9" });
    session.close();
    assert.deepEqual(reaps, ["work dir absent", "work dir present"], "reaped before the work dir is made, and before it is removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a survivor that cannot be killed refuses the run, as the sandbox being unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "scope-provider-"));
  try {
    const provider = createExecScopeProvider({ workRoot: root, sandbox: SELF, egress: { dev: [], install: [] }, reaper: { reapOrphans: () => { throw new SandboxResidueError([4242]); } } });
    await assert.rejects(async () => provider.open({ runId: "run-10" }), (err: unknown) => isSandboxUnavailable(err) && err.reason === "residue");
    assert.equal(existsSync(join(root, "run-10")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a survivor at the end of a run is said and does not stop the scope from closing", async () => {
  const root = mkdtempSync(join(tmpdir(), "scope-provider-"));
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  try {
    let calls = 0;
    const provider = createExecScopeProvider({ workRoot: root, sandbox: SELF, egress: { dev: [], install: [] }, reaper: { reapOrphans: () => { calls += 1; if (calls > 1) throw new SandboxResidueError([4242]); return 0; } } });
    const session = await provider.open({ runId: "run-11" });
    session.close();
    assert.equal(existsSync(join(root, "run-11")), false);
    assert.match(errors.join("\n"), /survived/);
  } finally {
    console.error = original;
    rmSync(root, { recursive: true, force: true });
  }
});
