/* The suite's preload (test-setup.mjs) fails a test that starts with the timers or the clock still replaced by a test
   before it, so a leak fails one test by name instead of hanging a shared worker. These run small test files in a
   node --test process of their own, as a shared worker runs them. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runsTestsInThisProcess } from "./test-global-guard.mjs";

const setup = join(import.meta.dirname, "..", "test-setup.mjs");

function runShared(t: { after: (fn: () => void) => void }, files: Record<string, string>): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "qayaba-global-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = Object.entries(files).map(([name, body]) => {
    const path = join(dir, name);
    writeFileSync(path, `import { test, mock } from "node:test";\n${body}\n`);
    return path;
  });
  /* The child is a worker of its own, not a per-file child of this test's runner. */
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(
    process.execPath,
    ["--import", setup, "--test", "--test-isolation=none", "--test-reporter=spec", "--test-timeout=20000", ...paths],
    { cwd: dir, env, encoding: "utf8", timeout: 60_000 },
  );
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

const realTimerWait = "await new Promise((resolve) => setTimeout(resolve, 5));";

test("a test that leaves the global mock timers on fails the next test to start, which names the replacement and the test before it", (t) => {
  const { status, output } = runShared(t, {
    "a-leaks.test.mjs": `test("enables the global mock timers and never resets them", () => { mock.timers.enable({ apis: ["setTimeout"] }); });`,
    "b-waits.test.mjs": `test("the next test", async () => { ${realTimerWait} });\ntest("a test after it", async () => { ${realTimerWait} });`,
  });

  assert.equal(status, 1, output);
  assert.match(output, /✖ the next test/);
  assert.match(output, /globalThis\.setTimeout/);
  assert.match(output, /enables the global mock timers and never resets them/);
  assert.match(output, /a-leaks\.test\.mjs/);
  assert.match(output, /✔ a test after it/, "the originals are put back, so the rest of the worker waits on real timers");
});

test("timers a test mocks with t.mock are its own: the tests after it start on real timers", (t) => {
  const { status, output } = runShared(t, {
    "a-scoped.test.mjs": `test("mocks setTimeout and Date for itself", (t) => { t.mock.timers.enable({ apis: ["setTimeout", "Date"] }); t.mock.timers.tick(10); });`,
    "b-waits.test.mjs": `test("the next test", async () => { ${realTimerWait} });`,
  });

  assert.equal(status, 0, output);
  assert.match(output, /✔ the next test/);
});

test("a subtest that starts inside a test that mocked time is not refused for its parent's timers", (t) => {
  const { status, output } = runShared(t, {
    "nested.test.mjs": `test("mocks setTimeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await t.test("a subtest under the parent's clock", () => {});
});
test("the next test", async () => { ${realTimerWait} });`,
  });

  assert.equal(status, 0, output);
  assert.match(output, /✔ a subtest under the parent's clock/);
  assert.match(output, /✔ the next test/);
});

test("the guard is installed where tests run, never in the parent that only starts a process per file", () => {
  assert.equal(runsTestsInThisProcess(["--test", "--test-isolation=none"], {}), true, "a shared worker");
  assert.equal(runsTestsInThisProcess([], { NODE_TEST_CONTEXT: "child-v8" }), true, "a per-file child");
  assert.equal(runsTestsInThisProcess(["--test"], {}), false, "the parent of per-file children");
});
