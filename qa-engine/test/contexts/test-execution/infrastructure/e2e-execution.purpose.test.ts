/* Every Playwright child of a run names what it was run for and under which namespace, so the trace can tell the whole suite from a run_spec call, a control load, a mutant's re-run or an observation run, all of which are `playwright-test`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ProcessKillAdapter } from "../../../../src/shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { createDefaultE2eCleanupDeps, createDefaultE2eExecuteDeps } from "@contexts/test-execution/infrastructure/e2e-execution.runner.ts";
import type { ExecPurpose } from "../../../../src/shared-kernel/exec-purpose.ts";

interface Spawn { purpose?: ExecPurpose; namespace?: string; commandClass?: string }

function rig() {
  const workRoot = mkdtempSync(join(tmpdir(), "qa-purpose-"));
  const spawned: Spawn[] = [];
  const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough }> = [];
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
    spawn: (_cmd: string, _args: readonly string[], options: Spawn) => {
      spawned.push({ ...(options.purpose ? { purpose: options.purpose } : {}), ...(options.namespace ? { namespace: options.namespace } : {}), ...(options.commandClass ? { commandClass: options.commandClass } : {}) });
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      children.push(child);
      setImmediate(() => child.emit("close", 0, null));
      return child;
    },
  };
  const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 5_000, exec as never, undefined, () => ({ ran: true, report: { stats: { expected: 1 }, suites: [] } }));
  return { exec: exec as never, deps, spawned, workRoot, cleanup: () => rmSync(workRoot, { recursive: true, force: true }) };
}

const base = (r: ReturnType<typeof rig>, namespace: string) => ({ dir: r.workRoot, baseUrl: "https://dev", namespace });

test("a whole-suite run is the suite, whatever namespace it runs under", async () => {
  const r = rig();
  try {
    await r.deps.runSuite(base(r, "run-7"));
    assert.deepEqual(r.spawned, [{ purpose: "suite", namespace: "run-7", commandClass: "playwright-test" }]);
  } finally {
    r.cleanup();
  }
});

test("a run_spec call (the writes counted) is a control load and then the run-spec child, each under the call's namespace", async () => {
  const r = rig();
  try {
    await r.deps.runSuite({ ...base(r, "run-7-rs2"), specFiles: ["flows/a.spec.ts"], countWrites: true, failureCaptureDir: join(r.workRoot, "dumps") });
    assert.deepEqual(r.spawned.map((s) => [s.purpose, s.namespace]), [["control", "run-7-rs2"], ["run-spec", "run-7-rs2"]]);
  } finally {
    r.cleanup();
  }
});

test("a mutant's re-run, an observation run and the caller's own name for a run are told apart", async () => {
  const r = rig();
  try {
    await r.deps.runSuite({ ...base(r, "run-7-mut0"), mutant: "{}" });
    await r.deps.runSuite({ ...base(r, "run-7-obs"), observe: true });
    await r.deps.runSuite({ ...base(r, "run-7-acc1"), purpose: "acceptance" });
    assert.deepEqual(r.spawned.map((s) => [s.purpose, s.namespace]), [["mutant", "run-7-mut0"], ["observation", "run-7-obs"], ["acceptance", "run-7-acc1"]]);
  } finally {
    r.cleanup();
  }
});

test("the orphan-data cleanup names itself", async () => {
  const r = rig();
  try {
    await createDefaultE2eCleanupDeps(new ProcessKillAdapter(), r.exec).runCleanup({ dir: r.workRoot, baseUrl: "https://dev", namespace: "qa-bot" });
    assert.deepEqual(r.spawned, [{ purpose: "cleanup", namespace: "qa-bot", commandClass: "playwright-test" }]);
  } finally {
    r.cleanup();
  }
});
