import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRESETS, checkerTsconfigFor, runOptionsFrom, sourcePathOf, summarize, testCommandFor, type MutationPreset } from "./mutate.ts";

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
