/* The launcher is where "agent code never runs as the orchestrator, with the orchestrator's environment, with open network" is decided, so each decision is pinned through the one spawn it makes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createExecSandbox, isSandboxUnavailable, resetExecSandboxWarnings, resolveExecSandboxMode, SandboxUnavailableError, type EgressGate, type ExecSandboxDeps } from "../../../src/shared-infrastructure/process-sandbox/exec-sandbox.ts";
import { SANDBOX_PROFILES } from "../../../src/shared-infrastructure/process-sandbox/exec-env.ts";
import { newSandboxReport, withExecScope, type RunScope } from "../../../src/shared-infrastructure/process-sandbox/exec-scope.ts";
import { SandboxResidueError } from "../../../src/shared-infrastructure/process-sandbox/sandbox-reaper.ts";
import { openRunWorkDir } from "../../../src/shared-infrastructure/process-sandbox/exec-workdir.ts";
import { AUTH_MATERIAL_FILES } from "../../../src/shared-infrastructure/process-sandbox/auth-session-env.ts";

const SANDBOX = { uid: process.getuid?.() ?? 1002, gid: process.getgid?.() ?? 1002, home: "/home/sandbox" };
const BASE: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/root", GITHUB_TOKEN: "ghp_x", DEV_TEST_PASS: "orchestrator-pass", QA_API_TOKEN: "tok" };

interface Spawned { cmd: string; args: string[]; options: SpawnOptions; child: ChildProcess & EventEmitter }

function harness(overrides: Partial<ExecSandboxDeps> = {}): { port: ReturnType<typeof createExecSandbox>; calls: Spawned[]; warnings: string[]; root: string; authDir: string; scope: RunScope } {
  resetExecSandboxWarnings();
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

test("a suite is told the DEV origins its egress lease holds, as data, and no caller can name others; no other profile is told them", () => {
  const h = harness();
  try {
    const scope: RunScope = { ...h.scope, egress: { dev: ["https://dev.example.com", "https://*.api.example.com:8443"], install: ["https://registry.npmjs.org"] } };
    h.port.spawn("npx", ["playwright"], { cwd: "/m", profile: "suite", scope, extraEnv: { PW_DEV_ORIGINS: JSON.stringify(["https://elsewhere.example.org"]) } });
    for (const profile of SANDBOX_PROFILES.filter((p) => p !== "suite")) h.port.spawn("npx", ["playwright"], { cwd: "/m", profile, scope, extraEnv: { PW_DEV_ORIGINS: JSON.stringify(["https://elsewhere.example.org"]) } });
    const suiteEnv = h.calls[0]!.options.env as Record<string, string>;
    assert.deepEqual(JSON.parse(suiteEnv.PW_DEV_ORIGINS ?? "null"), ["https://dev.example.com", "https://*.api.example.com:8443"]);
    for (const call of h.calls.slice(1)) assert.equal("PW_DEV_ORIGINS" in (call.options.env as Record<string, string>), false);
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

test("the graph profile holds a lease on no origin: the engine parses untrusted source and needs no network", () => {
  const gate = new FakeGate("enforce", true);
  const h = harness({ egress: gate });
  try {
    h.port.spawn("codegraph", ["sync", "-q", "."], { cwd: "/m", profile: "graph", commandClass: "code-graph", scope: h.scope });
    assert.deepEqual(gate.leases, [[]]);
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

test("QA_EXEC_SANDBOX: unset is required where the sandbox can exist (root on Linux) and best-effort elsewhere; the two names are accepted; anything else is a configuration error", () => {
  const asRoot = () => 0;
  const asUser = () => 1000;
  assert.equal(resolveExecSandboxMode({}, "linux", asRoot), "required", "a container running as root must not silently run agent code as root");
  assert.equal(resolveExecSandboxMode({ QA_EXEC_SANDBOX: "" }, "linux", asRoot), "required");
  assert.equal(resolveExecSandboxMode({}, "linux", asUser), "best-effort");
  assert.equal(resolveExecSandboxMode({}, "darwin", asRoot), "best-effort");
  assert.equal(resolveExecSandboxMode({ QA_EXEC_SANDBOX: "required" }, "darwin", asUser), "required");
  assert.equal(resolveExecSandboxMode({ QA_EXEC_SANDBOX: "best-effort" }, "linux", asRoot), "best-effort", "an explicit choice is the operator's");
  assert.throws(() => resolveExecSandboxMode({ QA_EXEC_SANDBOX: "off" }), /QA_EXEC_SANDBOX/);
});

test("the warning that agent code runs unisolated is said once per process, however many launchers there are", () => {
  const first = harness({ sandbox: null, mode: "best-effort" });
  const second = createExecSandbox({ sandbox: null, mode: "best-effort", baseEnv: BASE, spawnFn: (() => new EventEmitter()) as never, warn: (line) => first.warnings.push(line) });
  try {
    first.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline", scope: first.scope });
    second.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline", scope: first.scope });
    assert.equal(first.warnings.filter((w) => /best-effort/.test(w)).length, 1);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
  }
});

test("egress enforce without a sandbox uid refuses to spawn: the filter matches on that uid, so nothing would hold the child", () => {
  const h = harness({ sandbox: null, mode: "best-effort", egressMode: "enforce" });
  try {
    assert.throws(
      () => h.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "suite", scope: h.scope }),
      (err: unknown) => isSandboxUnavailable(err) && err.reason === "egress",
    );
    assert.equal(h.calls.length, 0);
    assert.equal(h.scope.report.refusal, "egress");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("egress warn without a sandbox uid runs the child unfiltered, says so once, and records it", () => {
  const h = harness({ sandbox: null, mode: "best-effort", egressMode: "warn" });
  try {
    h.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "suite", scope: h.scope });
    h.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "suite", scope: h.scope });
    assert.equal(h.calls.length, 2);
    assert.equal(h.scope.report.egress, "unenforced");
    assert.equal(h.warnings.filter((w) => /egress/i.test(w)).length, 1);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
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

test("a child that runs in a mirror gets that mirror opened to the sandbox group, once per run", () => {
  const opened: string[] = [];
  const ops = {
    lstat: () => ({ isDirectory: () => true, uid: 0 }),
    readdir: () => [],
    chown: (path: string, uid: number, gid: number) => { opened.push(`chown ${path} ${uid}:${gid}`); },
    chmod: () => {},
  };
  const h = harness({ mirrorRoot: "/app/.mirrors", mirrorOps: ops });
  try {
    h.port.spawn("npx", [], { cwd: "/app/.mirrors/org__app/e2e", profile: "suite", scope: h.scope });
    h.port.spawn("npx", [], { cwd: "/app/.mirrors/org__app/e2e", profile: "offline", scope: h.scope });
    h.port.spawn("npx", [], { cwd: "/tmp/elsewhere", profile: "offline", scope: h.scope });
    assert.deepEqual(opened, [`chown /app/.mirrors/org__app 0:${SANDBOX.gid}`]);
    assert.deepEqual([...(h.scope.openedMirrors ?? [])], ["/app/.mirrors/org__app"]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

function reaperLog(failWith?: Error): { reaper: { reapOrphans(): number }; reaps: number[] } {
  const reaps: number[] = [];
  return { reaps, reaper: { reapOrphans: () => { reaps.push(reaps.length); if (failWith) throw failWith; return 0; } } };
}

test("whatever an earlier child left running is ended before the next one starts", () => {
  const log = reaperLog();
  const h = harness({ reaper: log.reaper });
  try {
    h.port.spawn("npx", ["playwright"], { cwd: "/m", profile: "suite", scope: h.scope });
    assert.equal(log.reaps.length, 1);
    assert.equal(h.calls.length, 1);
    h.port.spawn("npx", ["playwright"], { cwd: "/m", profile: "login", account: { user: "u", pass: "p-pass-1" }, scope: h.scope });
    assert.equal(log.reaps.length, 2, "and again before a login, which carries the account");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a survivor that cannot be killed refuses the spawn: the next child would share its uid", () => {
  const log = reaperLog(new SandboxResidueError([4242]));
  const h = harness({ reaper: log.reaper });
  try {
    assert.throws(
      () => h.port.spawn("npx", ["playwright"], { cwd: "/m", profile: "login", account: { user: "u", pass: "p-pass-1" }, scope: h.scope }),
      (err: unknown) => isSandboxUnavailable(err) && err.reason === "residue",
    );
    assert.equal(h.calls.length, 0);
    assert.equal(h.scope.report.refusal, "residue");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("what the last live child left behind is ended when that child exits, and not while another is still running", () => {
  const log = reaperLog();
  let nextPid = 91000;
  const spawnFn = (() => Object.assign(new EventEmitter(), { pid: (nextPid += 1) })) as unknown as typeof import("node:child_process").spawn;
  const h = harness({ reaper: log.reaper, spawnFn });
  try {
    const a = h.port.spawn("npx", ["a"], { cwd: "/m", profile: "suite", scope: h.scope }) as ChildProcess & EventEmitter;
    const b = h.port.spawn("npx", ["b"], { cwd: "/m", profile: "suite", scope: h.scope }) as ChildProcess & EventEmitter;
    const before = log.reaps.length;
    a.emit("exit", 0, null);
    assert.equal(log.reaps.length, before, "b is still running, so what is around it is not an orphan yet");
    b.emit("exit", 0, null);
    assert.equal(log.reaps.length, before + 1);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a child is started with a home inside the run's work dir, never a home that outlives the run", () => {
  const h = harness();
  try {
    for (const profile of SANDBOX_PROFILES) h.port.spawn("npx", ["x"], { cwd: "/m", profile, scope: h.scope });
    for (const call of h.calls) {
      const env = call.options.env as Record<string, string>;
      assert.equal(env.HOME, join(h.scope.workDir, "home"));
      assert.notEqual(env.HOME, SANDBOX.home);
    }
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("required with a file boundary that does not hold refuses to spawn, says what is exposed, and records the refusal", () => {
  const h = harness({ mode: "required", fileBoundary: { breach: () => "/app/src is writable by the sandbox uid" } });
  try {
    assert.throws(
      () => h.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline", scope: h.scope }),
      (err: unknown) => err instanceof SandboxUnavailableError && err.reason === "files" && err.code === "E-SANDBOX" && /\/app\/src is writable/.test(err.message),
    );
    assert.equal(h.calls.length, 0);
    assert.equal(h.scope.report.refusal, "files");
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("best-effort with a file boundary that does not hold spawns and warns once, loudly", () => {
  const h = harness({ mode: "best-effort", fileBoundary: { breach: () => "/app/config is listable by the sandbox uid" } });
  try {
    h.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline", scope: h.scope });
    h.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline", scope: h.scope });
    assert.equal(h.calls.length, 2);
    assert.equal(h.warnings.filter((w) => /file boundary/.test(w)).length, 1);
    assert.equal(h.scope.report.refusal, undefined);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a file boundary that holds lets the child start as the sandbox uid", () => {
  const h = harness({ mode: "required", fileBoundary: { breach: () => undefined } });
  try {
    h.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline", scope: h.scope });
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.options.uid, SANDBOX.uid);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});
