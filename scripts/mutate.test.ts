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
  rangeProblemOf,
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

test("a line range names real lines of its file: it starts at line 1 or later, never ends before it starts and stops at the last line", () => {
  assert.equal(rangeProblemOf("src/a.ts", 10), undefined, "an entry with no range names the whole file");
  assert.equal(rangeProblemOf("src/a.ts:1-10", 10), undefined, "the first and the last line are in the file");
  assert.equal(rangeProblemOf("src/a.ts:5-5", 10), undefined, "a single line is a range");
  assert.match(rangeProblemOf("src/a.ts:0-3", 10)!, /line 1/);
  assert.match(rangeProblemOf("src/a.ts:7-6", 10)!, /before it starts/);
  assert.match(rangeProblemOf("src/a.ts:5-11", 10)!, /ends at line 11 but the file has 10 lines/);
  assert.match(rangeProblemOf("src/a.ts:5", 10)!, /start-end/);
});

test("every preset's line ranges lie inside their files (a range left past the end of an edited file would mutate nothing)", () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    for (const entry of preset.mutate) {
      const text = readFileSync(join(ROOT, sourcePathOf(entry)), "utf8");
      const lineCount = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      assert.equal(rangeProblemOf(entry, lineCount), undefined, `${name}: ${entry}`);
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
  assert.ok(sources.some((s) => s.endsWith("sse/call-fingerprint.ts")), "the tracker's call identity is mutated");
  assert.ok(preset.tests.some((t) => t.endsWith("sse/call-fingerprint.test.ts")), "the call identity's own tests run against every mutant");
  assert.ok(preset.tests.some((t) => t.endsWith("agent-efficiency-reconcile.contract.test.ts")), "the fine/coarse reconciliation contract runs against every mutant");
  assert.equal(preset.thresholds.break, null, "a new preset starts in signal mode");
});

test("the generation-end preset mutates exactly the classifier, the terminal mapping and the learning gates, against their own tests", () => {
  const preset = PRESETS["generation-end"];
  assert.ok(preset, "the generation-end preset exists");
  const sources = preset.mutate.map(sourcePathOf);
  assert.deepEqual(sources, [
    "qa-engine/src/contexts/generation/domain/generation-end.ts",
    "qa-engine/src/contexts/qa-run-orchestration/domain/helpers/generation-end-terminal.ts",
    "qa-engine/src/contexts/qa-run-orchestration/domain/helpers/learning-gates.ts",
  ]);
  for (const module of ["generation-end", "generation-end-terminal", "learning-gates"]) {
    assert.ok(preset.tests.some((t) => t.endsWith(`${module}.test.ts`)), `${module}'s own tests run against every mutant`);
  }
  assert.equal(preset.thresholds.break, null, "a new preset starts in signal mode");
});

test("the precondition-verdict preset mutates the typed precondition error, its terminal, the class entries and their resolution and the audit finding, against their own tests and the class consumers'", () => {
  const preset = PRESETS["precondition-verdict"];
  assert.ok(preset, "the precondition-verdict preset exists");
  assert.deepEqual([...new Set(preset.mutate.map(sourcePathOf))], [
    "qa-engine/src/contexts/qa-run-orchestration/domain/auth-precondition.ts",
    "qa-engine/src/contexts/qa-run-orchestration/domain/helpers/precondition-terminal.ts",
    "qa-engine/src/contexts/qa-run-orchestration/domain/helpers/error-class.ts",
    "qa-engine/src/contexts/cross-run-learning/domain/process-audit.ts",
  ]);
  for (const module of ["auth-precondition", "precondition-terminal", "error-class", "error-class-parity", "learning-gates", "process-audit"]) {
    assert.ok(preset.tests.some((t) => t.endsWith(`${module}.test.ts`)), `${module}'s tests run against every mutant`);
  }
  assert.equal(preset.thresholds.break, null, "a new preset starts in signal mode");
});

test("the patch-app-yaml preset mutates the config patcher, against its own tests and the update use case that drives it", () => {
  const preset = PRESETS["patch-app-yaml"];
  assert.ok(preset, "the patch-app-yaml preset exists");
  assert.deepEqual(preset.mutate.map(sourcePathOf), ["src/server/onboarding/patch-app-yaml.ts"]);
  for (const module of ["patch-app-yaml", "app-admin"]) {
    assert.ok(preset.tests.some((t) => t.endsWith(`${module}.test.ts`)), `${module}'s tests run against every mutant`);
  }
  assert.equal(preset.thresholds.break, null, "a new preset starts in signal mode");
});

test("the spec-path-confinement preset mutates the confined reader and the strict read and write, with the manifest IO, the manifest check of the read gate and the listing of the specs, against their own tests and the tests of the sites that go through them", () => {
  const preset = PRESETS["spec-path-confinement"];
  assert.ok(preset, "the spec-path-confinement preset exists");
  assert.deepEqual([...new Set(preset.mutate.map(sourcePathOf))], [
    "qa-engine/src/shared-infrastructure/spec-path-confinement.ts",
    "qa-engine/src/contexts/generation/infrastructure/manifest-fs.ts",
    "qa-engine/src/contexts/test-execution/infrastructure/static-gate.checks.ts",
    "qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/pre-generation-grounding-port.adapter.ts",
  ]);
  for (const tests of [
    "shared-infrastructure/spec-path-confinement.test.ts",
    "shared-infrastructure/spec-path-confinement.seam.test.ts",
    "shared-infrastructure/spec-path-confinement.owned.test.ts",
    "bridges/generation-port.adapter.test.ts",
    "bridges/review-dom-grounding-port.adapter.test.ts",
    "prompt-builders/prompts.test.ts",
    "infrastructure/manifest-fs.test.ts",
    "contract/coordination-disk-and-model.contract.test.ts",
    "bridges/pre-exec-grounding-port.adapter.test.ts",
    "infrastructure/static-gate.checks.test.ts",
    "bridges/pre-generation-grounding-port.adapter.test.ts",
    "bridges/pre-generation-grounding-port.context-map.test.ts",
  ]) {
    assert.ok(preset.tests.some((t) => t.endsWith(tests)), `${tests} runs against every mutant`);
  }
  assert.equal(preset.thresholds.break, null, "a new preset starts in signal mode");
});

test("the login-evidence preset mutates the classifier, the scrubber and the note in one module, against their own tests", () => {
  const preset = PRESETS["login-evidence"];
  assert.ok(preset, "the login-evidence preset exists");
  assert.deepEqual(preset.mutate.map(sourcePathOf), ["qa-engine/src/contexts/qa-run-orchestration/domain/helpers/login-evidence.ts"]);
  for (const module of ["login-evidence", "classify-login-evidence"]) {
    assert.ok(preset.tests.some((t) => t.endsWith(`${module}.test.ts`)), `${module}'s tests run against every mutant`);
  }
  assert.equal(preset.thresholds.break, null, "a new preset starts in signal mode");
});

test("the prompt-contract preset mutates the lint, the regeneration predicate, the diff size, the harness-facts scan and its reader, against their own tests and a sample of the matrix", () => {
  const preset = PRESETS["prompt-contract"];
  assert.ok(preset, "the prompt-contract preset exists");
  assert.deepEqual(preset.mutate.map(sourcePathOf), [
    "qa-engine/src/contexts/generation/domain/prompt-contract-lint.ts",
    "qa-engine/src/contexts/generation/domain/regen-turn.ts",
    "qa-engine/src/contexts/generation/domain/diff-stat.ts",
    "qa-engine/src/contexts/generation/domain/harness-facts.ts",
    "qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/pre-generation-grounding-port.adapter.ts",
  ]);
  for (const module of ["prompt-contract-lint", "regen-turn", "diff-stat", "harness-facts"]) {
    assert.ok(preset.tests.some((t) => t.endsWith(`${module}.test.ts`)), `${module}'s own tests run against every mutant`);
  }
  assert.ok(
    preset.tests.some((t) => t.endsWith("pre-generation-grounding-port.harness-facts.test.ts")),
    "the reader's own tests run against every mutant",
  );
  assert.ok(preset.tests.includes("scripts/prompt-contract-matrix.sample.test.ts"), "the sample of the matrix runs against every mutant, real prompts through every rule");
  assert.equal(preset.thresholds.break, null, "a new preset starts in signal mode");
});

test("the step-limit preset mutates the resolver, the lines that read, judge and route a limit, the agent-list read and the factory's per-run memo, against their own tests", () => {
  const preset = PRESETS["step-limit"];
  assert.ok(preset, "the step-limit preset exists");
  assert.deepEqual([...new Set(preset.mutate.map(sourcePathOf))], [
    "src/agent-runtime/step-limit.ts",
    "src/agent-runtime/opencode-strategy.ts",
    "src/agent-runtime/facades.ts",
    "src/integrations/opencode-client.ts",
    "src/server/rewritten-engine-factory.ts",
  ]);
  for (const module of ["step-limit", "opencode-strategy", "facades", "opencode-agents", "opencode-client", "rewritten-engine-factory.step-limit"]) {
    assert.ok(preset.tests.some((t) => t.endsWith(`${module}.test.ts`)), `${module}'s tests run against every mutant`);
  }
  assert.ok(
    !preset.tests.includes("src/server/rewritten-engine-factory.test.ts"),
    "the memo's own tests stand apart from the factory's whole test file, which would run once per mutant",
  );
  assert.equal(preset.thresholds.break, null, "a new preset starts in signal mode");
});

test("the route-capturability preset mutates the route classification, the pack's filter, cut and ranking call, and the whole ranking of the map's routes, against their own tests", () => {
  const preset = PRESETS["route-capturability"];
  assert.ok(preset, "the route-capturability preset exists");
  const sources = preset.mutate.map(sourcePathOf);
  for (const module of ["shared-kernel/route-capturability", "generation/domain/route-ranking", "generation/infrastructure/context-pack"]) {
    assert.ok(sources.some((s) => s.endsWith(`${module}.ts`)), `${module} is mutated`);
  }
  assert.ok(
    preset.mutate.includes("qa-engine/src/contexts/generation/domain/route-ranking.ts"),
    "the ranking is mutated whole, never narrowed to a range",
  );
  for (const module of ["route-capturability", "route-ranking", "context-pack"]) {
    assert.ok(preset.tests.some((t) => t.endsWith(`${module}.test.ts`)), `${module}'s own tests run against every mutant`);
  }
  assert.equal(preset.thresholds.break, null, "the preset stays in signal mode");
});

test("the carry-forward preset mutates the spec path and the one fold, the declarations, the merge, the attribution, the suite's entry and its listing whole, and only the lines that wire them in the use case, the adapters, the checks, the FixLoop and the run, against their own tests", () => {
  const preset = PRESETS["carry-forward"];
  assert.ok(preset, "the carry-forward preset exists");
  assert.deepEqual([...new Set(preset.mutate.map(sourcePathOf))], [
    "qa-engine/src/shared-kernel/spec-path.ts",
    "qa-engine/src/shared-kernel/delivered-spec.ts",
    "qa-engine/src/contexts/generation/domain/declared-specs.ts",
    "qa-engine/src/contexts/qa-run-orchestration/domain/helpers/delivered-specs.ts",
    "qa-engine/src/contexts/qa-run-orchestration/domain/helpers/contradiction-attribution.ts",
    "qa-engine/src/contexts/generation/domain/suite-entry.ts",
    "qa-engine/src/contexts/generation/domain/suite-listing.ts",
    "qa-engine/src/contexts/generation/application/generate-tests.use-case.ts",
    "qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/generation-port.adapter.ts",
    "qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/pre-generation-grounding-port.adapter.ts",
    "qa-engine/src/contexts/qa-run-orchestration/domain/helpers/selector-check.ts",
    "qa-engine/src/contexts/qa-run-orchestration/domain/pre-exec-grounding.service.ts",
    "qa-engine/src/contexts/qa-run-orchestration/domain/fix-loop.aggregate.ts",
    "qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts",
  ]);
  for (const whole of ["spec-path", "delivered-spec", "declared-specs", "delivered-specs", "contradiction-attribution", "suite-entry", "suite-listing"]) {
    assert.ok(preset.mutate.some((entry) => sourcePathOf(entry) === entry && entry.endsWith(`/${whole}.ts`)), `${whole} is mutated whole, never narrowed to a range`);
  }
  for (const wired of ["generate-tests.use-case", "generation-port.adapter", "pre-generation-grounding-port.adapter", "selector-check", "pre-exec-grounding.service", "fix-loop.aggregate", "run-qa.use-case"]) {
    assert.ok(
      preset.mutate.filter((entry) => sourcePathOf(entry).endsWith(`/${wired}.ts`)).every((entry) => sourcePathOf(entry) !== entry),
      `${wired} is narrowed to the lines that wire the carry-forward: the rest of it is other code`,
    );
  }
  for (const tests of [
    "shared-kernel/spec-path.test.ts",
    "shared-kernel/delivered-spec.test.ts",
    "domain/declared-specs.test.ts",
    "application/generate-tests.declared-specs.test.ts",
    "helpers/delivered-specs.test.ts",
    "helpers/contradiction-attribution.test.ts",
    "helpers/selector-check.origins.test.ts",
    "domain/pre-exec-grounding.service.test.ts",
    "domain/fix-loop.aggregate.test.ts",
    "domain/suite-entry.test.ts",
    "domain/suite-listing.test.ts",
    "application/run-qa.carry-forward.test.ts",
    "bridges/generation-port.adapter.test.ts",
    "bridges/pre-generation-grounding-port.adapter.test.ts",
  ]) {
    assert.ok(preset.tests.some((t) => t.endsWith(tests)), `${tests} runs against every mutant`);
  }
  assert.ok(
    !preset.tests.some((t) => t.endsWith("application/run-qa.use-case.test.ts")),
    "the run's carry-forward tests stand apart from its whole test file, which would run once per mutant",
  );
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
