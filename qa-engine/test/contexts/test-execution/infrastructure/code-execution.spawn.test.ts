/* Behavioral tests over the REAL spawning code-mode execution (createDefaultCodeExecuteDeps), the actual process boundary: process.execPath stands in for the repo's test command so no real package manager is needed. The repo under test is untrusted code, so its output is untrusted too. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import {
  createDefaultCodeExecuteDeps,
  CODE_TEST_OUTPUT_KEEP_CHARS,
  type CodeProject,
} from "@contexts/test-execution/infrastructure/code-execution.runner.ts";

function nodeTest(script: string): CodeProject {
  return {
    ecosystem: "node",
    install: null,
    test: { cmd: process.execPath, args: ["-e", script] },
  };
}

/* Literal halves joined at runtime, so the markers never appear in argv text. */
const FLOOD_LINE = "test flood-" + "line still running\\n";

test("a test run that floods output until the timeout is reported as a timeout with its newest output", { timeout: 30_000 }, async () => {
  const deps = createDefaultCodeExecuteDeps(null);
  const script =
    `const chunk = '${FLOOD_LINE}'.repeat(2000);` +
    "process.stdout.write('first-' + 'output-marker\\n');" +
    "(function go() { process.stdout.write(chunk, go); })();";
  const out = await deps.runTests(nodeTest(script), tmpdir(), { timeoutMs: 2500 });
  assert.equal(out.exitCode, null);
  assert.match(out.spawnError ?? "", /timeout/i, "the run ends as a timeout, not a crash");
  assert.match(out.logs, /flood-line/, "the newest output is kept");
  assert.doesNotMatch(out.logs, /first-output-marker/, "the oldest output was dropped");
  assert.ok(out.logs.length < CODE_TEST_OUTPUT_KEEP_CHARS * 2 + 1000, `the kept output stays bounded (was ${out.logs.length} chars)`);
});

test("a failing test run that wrote more than the bound keeps its exit code and its last lines", { timeout: 30_000 }, async () => {
  const deps = createDefaultCodeExecuteDeps(null);
  const script =
    "process.stdout.write('first-' + 'output-marker\\n');" +
    `const chunk = '${FLOOD_LINE}'.repeat(2000);` +
    "let written = 0;" +
    "(function go() {" +
    "  if (written++ < 120) return process.stdout.write(chunk, go);" +
    "  process.stderr.write('last-' + 'output-marker\\n', () => process.exit(2));" +
    "})();";
  const out = await deps.runTests(nodeTest(script), tmpdir());
  assert.equal(out.exitCode, 2);
  assert.match(out.logs, /last-output-marker/);
  assert.doesNotMatch(out.logs, /first-output-marker/);
  assert.ok(out.logs.length < CODE_TEST_OUTPUT_KEEP_CHARS * 2 + 1000, `the kept output stays bounded (was ${out.logs.length} chars)`);
});

test("multi-byte characters split across pipe reads are decoded intact", { timeout: 30_000 }, async () => {
  const deps = createDefaultCodeExecuteDeps(null);
  /* 3-byte characters in one large write: the pipe hands them over in fixed-size reads that cut through characters. */
  const script = "process.stdout.write('\\u20ac'.repeat(150000));";
  const out = await deps.runTests(nodeTest(script), tmpdir());
  assert.equal(out.exitCode, 0);
  assert.doesNotMatch(out.logs, /�/, "a character cut by a read boundary must not turn into a replacement character");
});
