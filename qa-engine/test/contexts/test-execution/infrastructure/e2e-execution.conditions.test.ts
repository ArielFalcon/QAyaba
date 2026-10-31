/* Every spec child of a run carries the conditions it ran under (RFC-0015): on its span, through the launcher's attributes, and back to the caller with its result. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ProcessKillAdapter } from "../../../../src/shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { createDefaultE2eExecuteDeps, runE2E } from "@contexts/test-execution/infrastructure/e2e-execution.runner.ts";
import type { Attrs } from "@kernel/telemetry/attribute-registry.ts";
import { contractDigest, executionConditions } from "@kernel/execution-conditions.ts";

interface Spawn { purpose?: string; attrs?: Attrs; env: Record<string, string>; args: readonly string[] }

function rig() {
  const workRoot = mkdtempSync(join(tmpdir(), "qa-conditions-"));
  const spawned: Spawn[] = [];
  const exec = {
    isolated: false,
    workDir: () => workRoot,
    allocDir: (prefix: string, subdirs: readonly string[] = []) => {
      const dir = mkdtempSync(join(workRoot, `${prefix}-`));
      for (const sub of subdirs) mkdirSync(join(dir, sub), { recursive: true });
      return dir;
    },
    writeScript: (name: string, content: string) => {
      const path = join(workRoot, `w-${spawned.length}-${name}`);
      writeFileSync(path, content);
      return path;
    },
    spawn: (_cmd: string, args: readonly string[], options: { purpose?: string; attrs?: Attrs; extraEnv?: Record<string, string> }) => {
      spawned.push({ ...(options.purpose ? { purpose: options.purpose } : {}), ...(options.attrs ? { attrs: options.attrs } : {}), env: options.extraEnv ?? {}, args });
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      setImmediate(() => child.emit("close", 0, null));
      return child;
    },
  };
  const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 5_000, exec as never, undefined, () => ({ ran: true, report: { stats: { expected: 1 }, suites: [] } }));
  return { deps, spawned, workRoot, cleanup: () => rmSync(workRoot, { recursive: true, force: true }) };
}

const GEO = { latitude: 40.4818, longitude: -3.3643 };

test("the spec child's span carries the contract's digest, its kind and the conditions it adds", async () => {
  const r = rig();
  try {
    await r.deps.runSuite({ dir: r.workRoot, baseUrl: "https://dev", namespace: "run-7-acc0", purpose: "acceptance", specFiles: ["flows/a.spec.ts"], retries: 0, geolocation: GEO });
    const attrs = r.spawned[0]!.attrs!;
    const expected = executionConditions({ purpose: "acceptance", instrumentation: { coverage: false, observe: false, route: false, writeCounter: false }, retries: 0, specFiles: ["flows/a.spec.ts"], processTimeoutMs: 5_000, geolocation: GEO, namespace: "run-7-acc0", startedAt: 0 });
    assert.equal(attrs["qayaba.exec.contract.digest"], contractDigest(expected));
    assert.equal(attrs["qayaba.exec.contract.kind"], "judging");
    assert.equal(attrs["qayaba.exec.contract.deviations"], "none");
    assert.equal(attrs["qayaba.exec.retries"], "0");
    assert.equal(attrs["qayaba.exec.spec_files"], "1");
  } finally {
    r.cleanup();
  }
});

test("a run_spec call records the write counter it adds, and its control load carries no conditions of its own", async () => {
  const r = rig();
  try {
    await r.deps.runSuite({ dir: r.workRoot, baseUrl: "https://dev", namespace: "run-7-rs1", specFiles: ["flows/a.spec.ts"], countWrites: true, failureCaptureDir: join(r.workRoot, "dumps") });
    const [control, spec] = r.spawned;
    assert.equal(control!.purpose, "control");
    assert.equal(control!.attrs, undefined);
    assert.equal(spec!.attrs!["qayaba.exec.contract.deviations"], "write-counter");
  } finally {
    r.cleanup();
  }
});

test("the session the run signed in is aged to the start of the child", async () => {
  const r = rig();
  try {
    const before = Date.now();
    const out = await r.deps.runSuite({ dir: r.workRoot, baseUrl: "https://dev", namespace: "run-7", session: { signedInAt: before - 60_000 } });
    const after = Date.now();
    const age = out.conditions!.session!.ageMs;
    assert.ok(age >= 60_000 && age <= 60_000 + (after - before), `age ${age}`);
    assert.equal(r.spawned[0]!.attrs!["qayaba.exec.session.age_ms"], age);
  } finally {
    r.cleanup();
  }
});

test("the caller of a run gets back the conditions it ran under", async () => {
  const r = rig();
  try {
    const result = await runE2E(r.workRoot, { baseUrl: "https://dev", namespace: "run-7", purpose: "suite" }, r.deps);
    assert.equal(result.conditions?.purpose, "suite");
    assert.equal(result.conditions?.specs.files, "suite");
    assert.equal(result.conditions?.retries, "config");
  } finally {
    r.cleanup();
  }
});

test("every spec child is told whether to measure coverage, and a judging one never measures", async () => {
  const r = rig();
  try {
    await r.deps.runSuite({ dir: r.workRoot, baseUrl: "https://dev", namespace: "run-7" });
    await r.deps.runSuite({ dir: r.workRoot, baseUrl: "https://dev", namespace: "run-7-acc0", purpose: "acceptance", specFiles: ["a.spec.ts"], retries: 0 });
    await r.deps.runSuite({ dir: r.workRoot, baseUrl: "https://dev", namespace: "run-7-mut0", mutant: JSON.stringify({ url: "https://dev/main.js", sha256: "h", start: 0, end: 1, replacement: "!" }), coverage: true });
    assert.deepEqual(r.spawned.map((s) => s.env.PW_COVERAGE), ["0", "0", "1"]);
    assert.equal(r.spawned[2]!.attrs!["qayaba.exec.contract.deviations"], "coverage,route");
  } finally {
    r.cleanup();
  }
});

test("a measurement runs only the tests it names, measured and observed, with a global timeout of its own", async () => {
  const r = rig();
  try {
    const out = await r.deps.runSuite({ dir: r.workRoot, baseUrl: "https://dev", namespace: "run-7-measure", purpose: "measurement", specFiles: ["flows/a.spec.ts"], tests: ["flows-a-spec-ts-opens-the-map"], coverage: true, observe: true, retries: 0, globalTimeoutMs: 120_000 });
    const [child] = r.spawned;
    assert.equal(child!.purpose, "measurement");
    assert.equal(child!.env.PW_COVERAGE, "1");
    assert.equal(child!.env.PW_OBSERVE, "1");
    assert.deepEqual(JSON.parse(child!.env.PW_MUTANT!).tests, ["flows-a-spec-ts-opens-the-map"]);
    assert.ok(child!.args.includes("--global-timeout=120000"));
    assert.equal(out.conditions?.kind, "measuring");
    assert.equal(out.conditions?.timeouts.globalMs, 120_000);
  } finally {
    r.cleanup();
  }
});
