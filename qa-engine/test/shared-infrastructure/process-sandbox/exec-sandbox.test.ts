/* The launcher is where "agent code never runs as the orchestrator, with the orchestrator's environment, with open network" is decided, so each decision is pinned through the one spawn it makes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createExecSandbox, resolveExecSandboxMode, SandboxUnavailableError, type EgressGate, type ExecSandboxDeps } from "../../../src/shared-infrastructure/process-sandbox/exec-sandbox.ts";
import { SANDBOX_PROFILES } from "../../../src/shared-infrastructure/process-sandbox/exec-env.ts";
import { newSandboxReport, withExecScope, type RunScope } from "../../../src/shared-infrastructure/process-sandbox/exec-scope.ts";
import { openRunWorkDir } from "../../../src/shared-infrastructure/process-sandbox/exec-workdir.ts";
import { AUTH_MATERIAL_FILES } from "../../../src/shared-infrastructure/process-sandbox/auth-session-env.ts";

const SANDBOX = { uid: process.getuid?.() ?? 1002, gid: process.getgid?.() ?? 1002, home: "/home/sandbox" };
const BASE: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/root", GITHUB_TOKEN: "ghp_x", DEV_TEST_PASS: "orchestrator-pass", QA_API_TOKEN: "tok" };

interface Spawned { cmd: string; args: string[]; options: SpawnOptions; child: ChildProcess & EventEmitter }

function harness(overrides: Partial<ExecSandboxDeps> = {}): { port: ReturnType<typeof createExecSandbox>; calls: Spawned[]; warnings: string[]; root: string; authDir: string; scope: RunScope } {
  const root = mkdtempSync(join(tmpdir(), "exec-sandbox-"));
  const authDir = join(root, "auth");
  const calls: Spawned[] = [];
  const warnings: string[] = [];
  const workDir = openRunWorkDir(join(root, "exec"), "run-1", null);
  const scope: RunScope = { runId: "run-1", workDir, authDir, egress: { dev: ["https://dev.example.com"], install: ["https://registry.npmjs.org"] }, report: newSandboxReport() };
  const spawnFn = ((cmd: string, args: string[], options: SpawnOptions) => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    calls.push({ cmd, args, options, child });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  const port = createExecSandbox({ sandbox: SANDBOX, mode: "required", baseEnv: BASE, spawnFn, warn: (line) => warnings.push(line), ...overrides });
  return { port, calls, warnings, root, authDir, scope };
}

test("every profile spawns as the sandbox uid and gid, detached, in the cwd it was given", () => {
  const h = harness();
  try {
    for (const profile of SANDBOX_PROFILES) h.port.spawn("npx", ["tsc"], { cwd: "/mirror/e2e", profile, scope: h.scope });
    assert.equal(h.calls.length, SANDBOX_PROFILES.length);
    for (const call of h.calls) {
      assert.equal(call.options.uid, SANDBOX.uid);
      assert.equal(call.options.gid, SANDBOX.gid);
      assert.equal(call.options.detached, true);
      assert.equal(call.options.cwd, "/mirror/e2e");
    }
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a child never inherits the orchestrator's secrets or its DEV_TEST_* account", () => {
  const h = harness();
  try {
    for (const profile of SANDBOX_PROFILES) h.port.spawn("node", ["x.js"], { cwd: "/m", profile, scope: h.scope });
    for (const call of h.calls) {
      const env = call.options.env as Record<string, string>;
      assert.equal("GITHUB_TOKEN" in env, false);
      assert.equal("QA_API_TOKEN" in env, false);
      assert.equal("DEV_TEST_PASS" in env, false);
    }
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a login carries the account it is given; a suite given the same account does not", () => {
  const h = harness();
  try {
    const account = { user: "acct", pass: "acct-pass-1" };
    h.port.spawn("npx", ["playwright"], { cwd: "/m", profile: "login", account, scope: h.scope });
    h.port.spawn("npx", ["playwright"], { cwd: "/m", profile: "suite", account, scope: h.scope });
    assert.equal((h.calls[0]!.options.env as Record<string, string>).DEV_TEST_PASS, "acct-pass-1");
    assert.equal("DEV_TEST_PASS" in (h.calls[1]!.options.env as Record<string, string>), false);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a suite is handed a copy of the saved session in the work dir, not the orchestrator's file", () => {
  const h = harness();
  try {
    mkdirSync(h.authDir, { recursive: true });
    writeFileSync(join(h.authDir, AUTH_MATERIAL_FILES.storageState), '{"cookies":[]}');
    h.port.spawn("npx", ["playwright", "test"], { cwd: "/m", profile: "suite", scope: h.scope });
    const env = h.calls[0]!.options.env as Record<string, string>;
    assert.equal(env.PW_STORAGE_STATE?.startsWith(h.scope.workDir), true);
    assert.equal(readFileSync(env.PW_STORAGE_STATE!, "utf8"), '{"cookies":[]}');
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("required without a sandbox uid refuses to spawn and says why", () => {
  const h = harness({ sandbox: null, mode: "required" });
  try {
    assert.throws(() => h.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline", scope: h.scope }), (err: unknown) => err instanceof SandboxUnavailableError && err.reason === "uid" && err.code === "E-SANDBOX");
    assert.equal(h.calls.length, 0);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("best-effort without a sandbox uid spawns as the current user and warns once, loudly", () => {
  const h = harness({ sandbox: null, mode: "best-effort" });
  try {
    h.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline", scope: h.scope });
    h.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline", scope: h.scope });
    assert.equal(h.calls.length, 2);
    assert.equal("uid" in h.calls[0]!.options, false);
    assert.equal(h.warnings.filter((w) => /best-effort/.test(w)).length, 1);
    assert.equal(h.port.isolated, false);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a spawn outside a run scope is refused", () => {
  const h = harness();
  try {
    assert.throws(() => h.port.spawn("npx", [], { cwd: "/m", profile: "offline" }), (err: unknown) => err instanceof SandboxUnavailableError && err.reason === "scope");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("the scope of the run the call is part of is used when none is passed", () => {
  const h = harness();
  try {
    withExecScope(h.scope, () => h.port.spawn("npx", [], { cwd: "/m", profile: "offline" }));
    assert.equal((h.calls[0]!.options.env as Record<string, string>).TMPDIR, join(h.scope.workDir, "tmp"));
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

class FakeGate implements EgressGate {
  leases: string[][] = [];
  releases = 0;
  constructor(readonly mode: "enforce" | "warn", private up: boolean) {}
  available(): boolean { return this.up; }
  lease(origins: readonly string[]) {
    this.leases.push([...origins]);
    return { release: () => { this.releases += 1; } };
  }
}

test("each profile holds a lease on its own origins until the child is gone", () => {
  const gate = new FakeGate("enforce", true);
  const h = harness({ egress: gate });
  try {
    h.port.spawn("npx", [], { cwd: "/m", profile: "suite", scope: h.scope });
    h.port.spawn("npm", ["ci"], { cwd: "/m", profile: "install", scope: h.scope });
    h.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline", scope: h.scope });
    assert.deepEqual(gate.leases, [["https://dev.example.com"], ["https://registry.npmjs.org"], []]);
    assert.equal(gate.releases, 0);
    for (const call of h.calls) call.child.emit("close", 0, null);
    assert.equal(gate.releases, 3);
    h.calls[0]!.child.emit("error", new Error("late"));
    assert.equal(gate.releases, 3, "a lease is released once");
    assert.equal(h.scope.report.egress, "enforced");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("enforce with the egress filter down refuses to spawn; warn runs unfiltered and records it", () => {
  const enforce = harness({ egress: new FakeGate("enforce", false) });
  try {
    assert.throws(() => enforce.port.spawn("npx", [], { cwd: "/m", profile: "suite", scope: enforce.scope }), (err: unknown) => err instanceof SandboxUnavailableError && err.reason === "egress");
  } finally {
    rmSync(enforce.root, { recursive: true, force: true });
  }
  const warn = harness({ egress: new FakeGate("warn", false) });
  try {
    warn.port.spawn("npx", [], { cwd: "/m", profile: "suite", scope: warn.scope });
    assert.equal(warn.calls.length, 1);
    assert.equal(warn.scope.report.egress, "unenforced");
    assert.equal(warn.warnings.some((w) => /egress/i.test(w)), true);
  } finally {
    rmSync(warn.root, { recursive: true, force: true });
  }
});

test("a lease is given back when the spawn itself throws", () => {
  const gate = new FakeGate("enforce", true);
  const h = harness({ egress: gate, spawnFn: (() => { throw new Error("EAGAIN"); }) as never });
  try {
    assert.throws(() => h.port.spawn("npx", [], { cwd: "/m", profile: "suite", scope: h.scope }), /EAGAIN/);
    assert.equal(gate.releases, 1);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("QA_EXEC_SANDBOX: unset is best-effort, the two names are accepted, anything else is a configuration error", () => {
  assert.equal(resolveExecSandboxMode({}), "best-effort");
  assert.equal(resolveExecSandboxMode({ QA_EXEC_SANDBOX: "required" }), "required");
  assert.equal(resolveExecSandboxMode({ QA_EXEC_SANDBOX: "best-effort" }), "best-effort");
  assert.throws(() => resolveExecSandboxMode({ QA_EXEC_SANDBOX: "off" }), /QA_EXEC_SANDBOX/);
});

test("a call's directory is fresh, inside the work dir, and carries the subdirectories asked for", () => {
  const h = harness();
  try {
    const a = h.port.allocDir("pw", ["report", "results"], h.scope);
    const b = h.port.allocDir("pw", ["report"], h.scope);
    assert.notEqual(a, b);
    assert.equal(a.startsWith(h.scope.workDir), true);
    assert.equal(statSync(join(a, "report")).isDirectory(), true);
    assert.equal(statSync(join(a, "results")).isDirectory(), true);
    assert.throws(() => h.port.allocDir("../escape", [], h.scope), /prefix/);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("directories inside the mirror are created for the sandbox on request", () => {
  const h = harness();
  try {
    const target = join(h.root, "mirror", "e2e", ".qa", "coverage");
    h.port.prepareWritable([target]);
    assert.equal(statSync(target).isDirectory(), true);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});
