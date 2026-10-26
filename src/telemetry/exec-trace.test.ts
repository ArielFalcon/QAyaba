/* A sandboxed child as a span: the launcher over a fake spawn seam and the real telemetry adapter. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { SpanStatusCode } from "@opentelemetry/api";
import { createExecSandbox, resetExecSandboxWarnings, type EgressGate, type ExecSandboxDeps } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox";
import { newSandboxReport, withExecScope, type RunScope } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-scope";
import { openRunWorkDir } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-workdir";
import { createRunSecretScope, withRunSecretScope } from "../../qa-engine/src/shared-kernel/run-secret-redaction";
import { ThrowingTelemetry } from "@kernel/telemetry/guarded-telemetry";
import { traceHarness } from "./trace-harness";

const SANDBOX = { uid: process.getuid?.() ?? 1002, gid: process.getgid?.() ?? 1002, home: "/home/sandbox" };
let nextPid = 40_000;

function launcher(overrides: Partial<ExecSandboxDeps> = {}) {
  resetExecSandboxWarnings();
  const root = mkdtempSync(join(tmpdir(), "exec-trace-"));
  const h = traceHarness();
  const children: Array<ChildProcess & EventEmitter> = [];
  const envs: Array<Record<string, string>> = [];
  const spawnFn = ((_cmd: string, _args: string[], options: SpawnOptions) => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    (child as { pid?: number }).pid = (nextPid += 1);
    children.push(child);
    envs.push(options.env as Record<string, string>);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  const scope: RunScope = { runId: "run-1", workDir: openRunWorkDir(join(root, "exec"), "run-1", null), egress: { dev: ["https://dev.example.com"], install: [] }, report: newSandboxReport() };
  const port = createExecSandbox({ sandbox: SANDBOX, mode: "required", baseEnv: { PATH: "/usr/bin" }, spawnFn, warn: () => {}, telemetry: h.telemetry, ...overrides });
  return { h, port, scope, children, envs, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("a child is a qayaba.exec span under the phase that is open, from its spawn to its close, with the exit code", () => {
  const t = launcher();
  try {
    const phase = t.h.telemetry.startSpan("qayaba.phase.validate");
    t.scope.telemetry = { parent: () => phase.context() };
    t.port.spawn("npx", ["tsc"], { cwd: "/m/e2e", profile: "offline", commandClass: "tsc", scope: t.scope });
    t.h.clock.advance(1_500);
    t.children[0]!.emit("exit", 2, null);
    t.children[0]!.emit("close", 2, null);
    phase.end();

    const exec = t.h.only("qayaba.exec");
    assert.equal(exec.parentSpanContext?.spanId, phase.context().spanId);
    assert.equal(exec.attributes["qayaba.exec.profile"], "offline");
    assert.equal(exec.attributes["qayaba.exec.command_class"], "tsc");
    assert.equal(exec.attributes["process.exit.code"], 2);
    assert.equal(exec.attributes["qayaba.exec.signal"], undefined);
    assert.equal(exec.status.code, SpanStatusCode.UNSET);
    assert.equal((exec.endTime[0] * 1e9 + exec.endTime[1] - (exec.startTime[0] * 1e9 + exec.startTime[1])) / 1e6, 1_500);
    assert.deepEqual(t.h.unended(), []);
  } finally {
    t.dispose();
  }
});

test("a page-opening child carries the app's geolocation in its span and its environment", () => {
  const t = launcher();
  try {
    const geolocation = { latitude: 40.4818, longitude: -3.3643 };
    t.port.spawn("npx", ["playwright", "test"], {
      cwd: "/m/e2e",
      profile: "suite",
      commandClass: "playwright-test",
      geolocation,
      scope: t.scope,
    });
    t.children[0]!.emit("exit", 0, null);
    t.children[0]!.emit("close", 0, null);

    const exec = t.h.only("qayaba.exec");
    assert.equal(exec.attributes["qayaba.geo.lat"], 40.4818);
    assert.equal(exec.attributes["qayaba.geo.lng"], -3.3643);
    assert.equal(t.envs[0]!.PW_GEO_LAT, "40.4818");
    assert.equal(t.envs[0]!.PW_GEO_LNG, "-3.3643");
  } finally {
    t.dispose();
  }
});

test("a call site that names no command class is recorded as other", () => {
  const t = launcher();
  try {
    t.port.spawn("node", ["x.js"], { cwd: "/m", profile: "suite", scope: t.scope });
    t.children[0]!.emit("close", 0, null);
    assert.equal(t.h.only("qayaba.exec").attributes["qayaba.exec.command_class"], "other");
  } finally {
    t.dispose();
  }
});

test("a child ended by a signal records the signal and no exit code", () => {
  const t = launcher();
  try {
    t.port.spawn("npx", ["playwright", "test"], { cwd: "/m", profile: "suite", commandClass: "playwright-test", scope: t.scope });
    t.children[0]!.emit("close", null, "SIGKILL");
    const exec = t.h.only("qayaba.exec");
    assert.equal(exec.attributes["qayaba.exec.signal"], "SIGKILL");
    assert.equal(exec.attributes["process.exit.code"], undefined);
  } finally {
    t.dispose();
  }
});

test("the launcher adds no error listener to a child: an error event still throws where the call site has none, as without telemetry", () => {
  const t = launcher();
  const bare = launcher({ telemetry: undefined });
  try {
    t.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline", scope: t.scope });
    bare.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline", scope: bare.scope });
    assert.equal(t.children[0]!.listenerCount("error"), 0);
    assert.throws(() => t.children[0]!.emit("error", new Error("spawn npx ENOENT")), /ENOENT/);
    assert.throws(() => bare.children[0]!.emit("error", new Error("spawn npx ENOENT")), /ENOENT/);
  } finally {
    t.dispose();
    bare.dispose();
  }
});

test("a child that could not start still ends its span, on the close that follows its error, once", () => {
  const t = launcher();
  try {
    const child = t.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline", scope: t.scope });
    child.on("error", () => {});
    t.children[0]!.emit("error", new Error("spawn npx ENOENT"));
    t.children[0]!.emit("close", null, null);
    t.children[0]!.emit("close", null, null);
    assert.equal(t.h.named("qayaba.exec").length, 1);
    assert.deepEqual(t.h.unended(), []);
  } finally {
    t.dispose();
  }
});

test("a child whose streams never close still ends its span after its exit", async () => {
  const t = launcher({ exitGraceMs: 5 });
  try {
    t.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline", scope: t.scope });
    t.children[0]!.emit("exit", 3, null);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const exec = t.h.only("qayaba.exec");
    assert.equal(exec.attributes["process.exit.code"], 3);
  } finally {
    t.dispose();
  }
});

test("telemetry that fails while the span is being set up changes nothing about the spawn or the egress lease", () => {
  const leases: string[] = [];
  const egress: EgressGate = { mode: "enforce", available: () => true, lease: () => ({ release: () => leases.push("released") }) };
  const t = launcher({ egress, telemetry: new ThrowingTelemetry() });
  try {
    t.scope.telemetry = { parent: () => { throw new Error("parent lookup failed"); } };
    const child = t.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "suite", scope: t.scope });
    assert.equal(child, t.children[0]);
    t.children[0]!.emit("close", 0, null);
    assert.deepEqual(leases, ["released"]);
  } finally {
    t.dispose();
  }
});

test("a spawn that throws leaves no open span behind", () => {
  const t = launcher({ spawnFn: (() => { throw new Error("EAGAIN"); }) as unknown as typeof import("node:child_process").spawn });
  try {
    assert.throws(() => t.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline", scope: t.scope }), /EAGAIN/);
    assert.deepEqual(t.h.unended(), []);
  } finally {
    t.dispose();
  }
});

test("a refused spawn opens no span", () => {
  const t = launcher({ sandbox: null, mode: "required" });
  try {
    assert.throws(() => t.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline", scope: t.scope }), /sandbox uid/);
    assert.equal(t.h.spans().length + t.h.unended().length, 0);
  } finally {
    t.dispose();
  }
});

test("a child gets no trace context in its environment", () => {
  const t = launcher({ baseEnv: { PATH: "/usr/bin", TRACEPARENT: "00-aaaa-bbbb-01" } });
  try {
    for (const profile of ["offline", "suite", "login", "install"] as const) t.port.spawn("node", ["x.js"], { cwd: "/m", profile, scope: t.scope });
    for (const env of t.envs) {
      assert.equal(Object.keys(env).some((k) => k.toLowerCase() === "traceparent" || k.toLowerCase() === "tracestate"), false);
    }
  } finally {
    t.dispose();
  }
});

test("the processes the reaper ended when the last child left are on that child's span", () => {
  const t = launcher({ reaper: { reapOrphans: () => 3 } });
  try {
    t.port.spawn("npx", ["playwright", "test"], { cwd: "/m", profile: "suite", scope: t.scope });
    t.children[0]!.emit("exit", 0, null);
    t.children[0]!.emit("close", 0, null);
    assert.equal(t.h.only("qayaba.exec").attributes["qayaba.reaper.killed"], 3);
  } finally {
    t.dispose();
  }
});

const gate = (): EgressGate => ({ mode: "enforce", available: () => true, lease: () => ({ release: () => {} }) });
const refuse = (scope: RunScope, host: string): void => {
  for (const watcher of scope.report.watchers ?? []) watcher(host);
};

test("the hosts the egress filter refused while a child was alive are on its span, and those refused before or after are not", () => {
  const t = launcher({ egress: gate() });
  try {
    refuse(t.scope, "before.example");
    t.port.spawn("npx", ["playwright", "test"], { cwd: "/m", profile: "suite", commandClass: "playwright-test", scope: t.scope });
    refuse(t.scope, "analytics.example");
    refuse(t.scope, "analytics.example");
    refuse(t.scope, "cdn.example");
    t.children[0]!.emit("close", 0, null);
    refuse(t.scope, "after.example");

    const exec = t.h.only("qayaba.exec");
    assert.deepEqual(exec.attributes["qayaba.egress.denied_cotemporal"], ["analytics.example", "cdn.example"]);
    assert.equal(t.scope.report.watchers?.size ?? 0, 0);
    const denied = t.h.measurements.filter((m) => m.name === "qayaba.egress.denied");
    assert.deepEqual(denied.map((m) => m.attrs["qayaba.exec.profile"]), ["suite"]);
  } finally {
    t.dispose();
  }
});

test("a child that met no refusal has no denied-hosts attribute and records no denial", () => {
  const t = launcher({ egress: gate() });
  try {
    t.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "install", scope: t.scope });
    t.children[0]!.emit("close", 0, null);
    assert.equal(t.h.only("qayaba.exec").attributes["qayaba.egress.denied_cotemporal"], undefined);
    assert.equal(t.h.measurements.filter((m) => m.name === "qayaba.egress.denied").length, 0);
  } finally {
    t.dispose();
  }
});

test("a refused host that is one of the run's own secrets is redacted on the span", () => {
  const t = launcher({ egress: gate() });
  try {
    const secrets = createRunSecretScope();
    secrets.addAccountSecrets(["leaky-token-value"]);
    withRunSecretScope(secrets, () => {
      t.port.spawn("node", ["x.js"], { cwd: "/m", profile: "suite", scope: t.scope });
      refuse(t.scope, "leaky-token-value.example");
      t.children[0]!.emit("close", 0, null);
    });
    assert.ok(!JSON.stringify(t.h.only("qayaba.exec").attributes).includes("leaky-token-value"));
  } finally {
    t.dispose();
  }
});

test("a telemetry port that throws gives the same spawn, env and lease as no telemetry", () => {
  const observe = (telemetry: ExecSandboxDeps["telemetry"]) => {
    const leases: string[] = [];
    const egress: EgressGate = { mode: "enforce", available: () => true, lease: (origins) => { leases.push(origins.join(",")); return { release: () => leases.push("released") }; } };
    const t = launcher({ telemetry, egress });
    try {
      const child = t.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "suite", commandClass: "tsc", scope: t.scope });
      t.children[0]!.emit("close", 0, null);
      const env = Object.fromEntries(Object.entries(t.envs[0]!).map(([k, v]) => [k, v.replace(/exec-trace-\w+/g, "ROOT")]));
      return { sameChild: child === t.children[0], env, leases };
    } finally {
      t.dispose();
    }
  };
  const broken = observe(new ThrowingTelemetry());
  const quiet = observe(undefined);
  assert.equal(broken.sameChild, true);
  assert.deepEqual(broken.env, quiet.env);
  assert.deepEqual(broken.leases, quiet.leases);
});

test("outside a run scope the launcher still refuses to spawn, with telemetry on", () => {
  const t = launcher();
  try {
    assert.throws(() => t.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline" }), /no run scope/);
    withExecScope(t.scope, () => t.port.spawn("npx", ["tsc"], { cwd: "/m", profile: "offline" }));
    assert.equal(t.children.length, 1);
  } finally {
    t.dispose();
  }
});
