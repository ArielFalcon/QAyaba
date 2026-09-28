import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRESETS,
  checkerTsconfigFor,
  clearPreviousReport,
  concurrencyFor,
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

test("a run uses at most 8 workers and leaves two CPUs free, never fewer than one worker", () => {
  assert.equal(concurrencyFor(plain, {}, 10), 8);
  assert.equal(concurrencyFor(plain, {}, 12), 8);
  assert.equal(concurrencyFor(plain, {}, 6), 4);
  assert.equal(concurrencyFor(plain, {}, 2), 1);
});

test("a preset's own concurrency caps the workers, and --concurrency overrides every preset", () => {
  const capped: MutationPreset = { ...plain, concurrency: 2 };
  assert.equal(concurrencyFor(capped, {}, 10), 2);
  assert.equal(concurrencyFor(capped, {}, 3), 1, "the cap never raises the machine default");
  assert.equal(concurrencyFor(capped, { concurrency: 5 }, 10), 5);
  assert.equal(concurrencyFor(plain, { concurrency: 1 }, 10), 1);
});

test("the write-confinement preset, whose tests spawn git, runs with fewer workers than the default", () => {
  assert.ok(concurrencyFor(PRESETS["write-confinement"]!, {}, 10) < concurrencyFor(plain, {}, 10));
});

test("--concurrency=N sets the worker count without being read as the preset name; a bad value is ignored", () => {
  const opts = runOptionsFrom(["--concurrency=3", "keystone"]);
  assert.equal(opts.preset, "keystone");
  assert.equal(opts.concurrency, 3);
  assert.equal(runOptionsFrom(["keystone"]).concurrency, undefined);
  assert.equal(runOptionsFrom(["keystone", "--concurrency=0"]).concurrency, undefined);
  assert.equal(runOptionsFrom(["keystone", "--concurrency=two"]).concurrency, undefined);
});
