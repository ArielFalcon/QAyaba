import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRESETS,
  checkerTsconfigFor,
  clearPreviousReport,
  concurrencyFor,
  FREE_CPUS,
  MAX_WORKERS,
  runOptionsFrom,
  sourcePathOf,
  summarize,
  testCommandFor,
  type MutationPreset,
} from "./mutate.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every preset names source files and test files that exist (a moved module must not silently kill the gate)", () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    assert.ok(preset.mutate.length > 0, `${name}: nothing to mutate`);
    assert.ok(preset.tests.length > 0, `${name}: no test files`);
    for (const entry of preset.mutate) {
      assert.ok(existsSync(join(ROOT, sourcePathOf(entry))), `${name}: mutate target ${entry} does not exist`);
    }
    for (const t of preset.tests) {
      assert.ok(existsSync(join(ROOT, t)), `${name}: test file ${t} does not exist`);
    }
  }
});

test("the keystone preset mutates the change-coverage decision and assembly modules", () => {
  const sources = PRESETS.keystone!.mutate.map(sourcePathOf);
  assert.ok(sources.some((s) => s.endsWith("objective-signal/domain/decide-coverage.service.ts")));
  assert.ok(sources.some((s) => s.endsWith("objective-signal/domain/assemble-change-coverage.ts")));
});

test("the agent-efficiency preset mutates the pure classification modules and the call tracker, against their own and their consumers' tests", () => {
  const preset = PRESETS["agent-efficiency"];
  assert.ok(preset, "the agent-efficiency preset exists");
  const sources = preset.mutate.map(sourcePathOf);
  for (const module of ["tool-call-taxonomy", "call-sequence", "provided-context", "step-exhaustion", "coarse-run-efficiency", "turn-efficiency-summary"]) {
    assert.ok(sources.some((s) => s.endsWith(`generation/domain/${module}.ts`)), `${module} is mutated`);
  }
  assert.ok(sources.some((s) => s.endsWith("sse/call-efficiency-tracker.ts")), "the tracker is mutated");
  assert.ok(preset.tests.some((t) => t.endsWith("agent-efficiency-reconcile.contract.test.ts")), "the fine/coarse reconciliation contract runs against every mutant");
  assert.equal(preset.thresholds.break, null, "a new preset starts in signal mode");
});

test("a mutant run executes only the preset's own test files, under the tracked-tree write guard", () => {
  const preset: MutationPreset = {
    description: "x",
    mutate: ["src/a.ts"],
    tests: ["src/a.test.ts", "src/b.test.ts"],
    thresholds: { high: 90, low: 80, break: null },
  };
  const command = testCommandFor(preset);
  assert.match(command, /--import \.\/test-setup\.mjs/);
  assert.match(command, /--test "src\/a\.test\.ts" "src\/b\.test\.ts"$/);
});

/* Whether a process still exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/* Polls a process-boundary condition; the deadline only ends a failing wait so the test can clean up. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`still waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/* Stryker reads a mutant as killed exactly when the test command exits non-zero. */
test("the test command exits as the preset's tests do: non-zero when one fails, zero when all pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-mutate-status-"));
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const statusOf = (body: string): number | null => {
      const file = join(dir, `${Math.random().toString(36).slice(2)}.test.mjs`);
      writeFileSync(file, `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("t", () => { ${body} });\n`);
      return spawnSync("/bin/sh", ["-c", testCommandFor({ ...plain, tests: [file] })], { cwd: ROOT, env, stdio: "ignore" }).status;
    };
    assert.notEqual(statusOf("assert.equal(1, 2);"), 0);
    assert.equal(statusOf("assert.equal(1, 1);"), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* Stryker runs the test command through a shell and, on a timeout, kills what it can see of it with
   SIGKILL. A test file spinning on an infinite-loop mutant — and anything it started — must die with
   it, or it keeps a CPU busy for the rest of the run and beyond. */
test("every process a timed-out test command started dies once the command is killed", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-mutate-orphans-"));
  const pidFile = join(dir, "pids");
  const spinning = join(dir, "spinning.test.mjs");
  writeFileSync(
    spinning,
    `import { spawn } from "node:child_process";\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `const child = spawn(process.execPath, ["-e", "for (;;) {}"], { stdio: "ignore" });\n` +
      `writeFileSync(${JSON.stringify(pidFile)}, \`\${process.pid} \${child.pid}\`);\n` +
      `for (;;) {}\n`,
  );
  let pids: number[] = [];
  try {
    /* Run as Stryker runs it, not as a child of this test run (which node --test marks in the env). */
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const runner = spawn("/bin/sh", ["-c", testCommandFor({ ...plain, tests: [spinning] })], { cwd: ROOT, env, stdio: "ignore" });
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").includes(" "), "the test file to start");
    pids = readFileSync(pidFile, "utf8").split(" ").map(Number);
    process.kill(runner.pid!, "SIGKILL");

    await until(() => pids.every((pid) => !alive(pid)), "the test file and what it started to die");
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run re-tests every mutant unless incremental mode is asked for (the command runner cannot see test-file changes)", () => {
  assert.equal(runOptionsFrom(["keystone"]).incremental, false);
  assert.equal(runOptionsFrom(["keystone", "--incremental"]).incremental, true);
  assert.equal(runOptionsFrom(["--incremental", "keystone"]).preset, "keystone");
});

test("the checker type-checks the mutated file without its line range, with the options of its own project", () => {
  const engine = checkerTsconfigFor(
    { description: "x", mutate: ["qa-engine/src/x.ts:10-20"], tests: ["t.ts"], thresholds: { high: 90, low: 80, break: null } },
    "/repo",
  ) as { extends: string; files: string[] };
  assert.deepEqual(engine.files, ["/repo/qa-engine/src/x.ts"]);
  assert.equal(engine.extends, "/repo/qa-engine/tsconfig.json");

  const shell = checkerTsconfigFor(
    { description: "x", mutate: ["src/server/auth.ts:1-5"], tests: ["t.ts"], thresholds: { high: 90, low: 80, break: null } },
    "/repo",
  ) as { extends: string; files: string[] };
  assert.deepEqual(shell.files, ["/repo/src/server/auth.ts"]);
  assert.equal(shell.extends, "/repo/tsconfig.json");
});

test("the score counts killed and timed-out mutants over valid ones; compile errors and ignored mutants are not valid", () => {
  const at = (line: number) => ({ start: { line, column: 1 } });
  const s = summarize({
    files: {
      "a.ts": {
        mutants: [
          { status: "Killed", mutatorName: "M", location: at(1) },
          { status: "Killed", mutatorName: "M", location: at(2) },
          { status: "Killed", mutatorName: "M", location: at(3) },
          { status: "Timeout", mutatorName: "M", location: at(4) },
          { status: "Survived", mutatorName: "EqualityOperator", replacement: "a > b", location: at(5) },
          { status: "NoCoverage", mutatorName: "M", location: at(6) },
          { status: "CompileError", mutatorName: "M", location: at(7) },
          { status: "CompileError", mutatorName: "M", location: at(8) },
          { status: "Ignored", mutatorName: "M", location: at(9) },
        ],
      },
    },
  });
  assert.equal(s.mutants, 9);
  assert.equal(s.compileErrors, 2);
  assert.equal(s.ignored, 1);
  assert.equal(s.score, 66.67);
  assert.equal(s.survivors.length, 2);
  assert.match(s.survivors[0]!, /a\.ts:5:1\s+EqualityOperator\s+"a > b"/);
});

test("a run with no valid mutants has no score rather than a perfect one", () => {
  const s = summarize({ files: { "a.ts": { mutants: [{ status: "CompileError", mutatorName: "M", location: { start: { line: 1, column: 1 } } }] } } });
  assert.equal(s.score, null);
});

test("timed-out mutants are reported apart from killed ones: the killed-only score leaves them out", () => {
  const at = (line: number) => ({ start: { line, column: 1 } });
  const s = summarize({
    files: {
      "a.ts": {
        mutants: [
          { status: "Killed", mutatorName: "M", location: at(1) },
          { status: "Timeout", mutatorName: "M", location: at(2) },
          { status: "Timeout", mutatorName: "M", location: at(3) },
          { status: "Survived", mutatorName: "M", location: at(4) },
        ],
      },
    },
  });
  assert.equal(s.killed, 1);
  assert.equal(s.timeout, 2);
  assert.equal(s.score, 75);
  assert.equal(s.killedScore, 25);
});

test("a run starts without the preset's previous report, so a failed run never prints a stale summary", () => {
  const root = mkdtempSync(join(tmpdir(), "mutate-report-"));
  try {
    const dir = join(root, "reports", "mutation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keystone.json"), "{}");
    writeFileSync(join(dir, "keystone.incremental.json"), "{}");
    writeFileSync(join(dir, "fix-loop.json"), "{}");
    clearPreviousReport(root, "keystone");
    assert.equal(existsSync(join(dir, "keystone.json")), false);
    assert.equal(existsSync(join(dir, "keystone.incremental.json")), true, "incremental state survives for --incremental");
    assert.equal(existsSync(join(dir, "fix-loop.json")), true, "other presets' reports are untouched");
    clearPreviousReport(root, "absent-preset");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const plain: MutationPreset = { description: "x", mutate: ["src/a.ts"], tests: ["t.ts"], thresholds: { high: 90, low: 80, break: null } };

test("a run never starts more than the worker cap, however many CPUs the machine has", () => {
  for (const cpus of [MAX_WORKERS + FREE_CPUS, MAX_WORKERS + FREE_CPUS + 1, 64]) {
    assert.equal(concurrencyFor(plain, {}, cpus), MAX_WORKERS, `${cpus} CPUs`);
  }
});

test("below the cap a run uses every CPU but the ones it leaves free, and never fewer than one worker", () => {
  for (let cpus = 1; cpus <= MAX_WORKERS + FREE_CPUS; cpus++) {
    const workers = concurrencyFor(plain, {}, cpus);
    assert.ok(workers >= 1, `${cpus} CPUs: at least one worker`);
    assert.ok(workers <= Math.max(1, cpus - FREE_CPUS), `${cpus} CPUs: ${FREE_CPUS} left free`);
  }
  const busiest = MAX_WORKERS + FREE_CPUS - 1;
  assert.equal(concurrencyFor(plain, {}, busiest), busiest - FREE_CPUS, "every CPU not left free gets a worker");
});

test("a preset's own concurrency caps the workers, and --concurrency overrides every preset", () => {
  const bigMachine = MAX_WORKERS + FREE_CPUS;
  const capped: MutationPreset = { ...plain, concurrency: 2 };
  assert.equal(concurrencyFor(capped, {}, bigMachine), 2);
  assert.equal(concurrencyFor(capped, {}, FREE_CPUS + 1), 1, "the cap never raises the machine default");
  assert.equal(concurrencyFor(capped, { concurrency: 5 }, bigMachine), 5);
  assert.equal(concurrencyFor(plain, { concurrency: 1 }, bigMachine), 1);
});

test("the write-confinement preset, whose tests spawn git, runs with fewer workers than the default", () => {
  assert.ok(concurrencyFor(PRESETS["write-confinement"]!, {}, MAX_WORKERS + FREE_CPUS) < concurrencyFor(plain, {}, MAX_WORKERS + FREE_CPUS));
});

test("--concurrency=N sets the worker count without being read as the preset name; a bad value is ignored", () => {
  const opts = runOptionsFrom(["--concurrency=3", "keystone"]);
  assert.equal(opts.preset, "keystone");
  assert.equal(opts.concurrency, 3);
  assert.equal(runOptionsFrom(["keystone"]).concurrency, undefined);
  assert.equal(runOptionsFrom(["keystone", "--concurrency=0"]).concurrency, undefined);
  assert.equal(runOptionsFrom(["keystone", "--concurrency=two"]).concurrency, undefined);
});
