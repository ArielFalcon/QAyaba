/* Behavioral tests over the REAL spawning code-mode execution (createDefaultCodeExecuteDeps), the actual process boundary: process.execPath stands in for the repo's test command so no real package manager is needed. The repo under test is untrusted code, so its output is untrusted too. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultCodeExecuteDeps,
  runCodeTests,
  runCodeCoverage,
  gitWorkingChanges,
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

test("coverage of a suite that writes far more than a pipe buffer still finishes instead of stalling on unread output", { timeout: 60_000 }, async () => {
  const repo = mkdtempSync(join(tmpdir(), "coverage-noisy-suite-"));
  try {
    /* The suite writes ~1 MB, many pipe buffers' worth of output that nobody reads unless the runner drains it. */
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node noisy-suite.js" } }));
    writeFileSync(join(repo, "noisy-suite.js"), "process.stdout.write('coverage noise line\\n'.repeat(50000));");
    await runCodeCoverage(repo, null, { timeoutMs: 15_000 });
    assert.ok(existsSync(join(repo, "coverage", "lcov.info")), "the run finished and its coverage report was written, instead of being killed at the timeout");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/* A code-mode run hands the working copy to the unprivileged sandbox user, so git run as the orchestrator
   judges it owned by someone else ("dubious ownership"). GIT_TEST_ASSUME_DIFFERENT_OWNER makes git apply
   that same check to a copy this test's own user created. */
test("the working-copy changes are listed even when git judges the tree owned by another user", () => {
  const repo = mkdtempSync(join(tmpdir(), "code-mode-other-owner-"));
  const previous = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, "generated.test.js"), "// a test the agent wrote\n");
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
    assert.deepEqual(gitWorkingChanges(repo), ["generated.test.js"]);
  } finally {
    if (previous === undefined) delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    else process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = previous;
    rmSync(repo, { recursive: true, force: true });
  }
});

/* The sandbox owns the working copy and can swap the root-owned `.git` for one of its own; its config would plant
   a command that git runs as the orchestrator. A `.git` that is a link to such a directory is the swap a test
   user can build without root. */
test("the working-copy changes are never read through a swapped git dir, and the planted command does not run", () => {
  const root = mkdtempSync(join(tmpdir(), "code-mode-swapped-git-"));
  const repo = join(root, "repo");
  const marker = join(root, "marker");
  try {
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "generated.test.js"), "// a test the agent wrote\n");
    const planted = join(root, "planted-git");
    cpSync(join(repo, ".git"), planted, { recursive: true });
    const evil = join(root, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\necho ran >> "${marker}"\nexit 0\n`, { mode: 0o755 });
    execFileSync("git", ["config", "--file", join(planted, "config"), "core.fsmonitor", evil]);
    rmSync(join(repo, ".git"), { recursive: true });
    symlinkSync(planted, join(repo, ".git"));

    assert.throws(() => gitWorkingChanges(repo), /git dir|\.git/i, "a git dir that is not the orchestrator's is a loud error, never an empty change list");
    assert.equal(existsSync(marker) && readFileSync(marker, "utf8").includes("ran"), false, "git never ran against the swapped git dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* The sandbox controls the submodule checkouts inside the working copy, including a git dir of their own whose filter
   driver git would run as the orchestrator while it compares the submodule's files during a status. */
test("the working-copy changes are listed without entering a submodule the sandbox controls", () => {
  const root = mkdtempSync(join(tmpdir(), "code-mode-submodule-"));
  const repo = join(root, "repo");
  const origin = join(root, "sub-origin");
  const marker = join(root, "marker");
  const identity = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" };
  const git = (cwd: string, ...args: string[]): void => void execFileSync("git", args, { cwd, env: identity, stdio: "ignore" });
  try {
    git(root, "init", "-q", origin);
    writeFileSync(join(origin, "f.txt"), "a\n");
    git(origin, "add", "f.txt");
    git(origin, "commit", "-qm", "sub");
    git(root, "init", "-q", repo);
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, "sub");
    git(repo, "commit", "-qm", "add submodule");
    /* The sandbox swaps the submodule's git dir for a repository of its own, with a filter driver that records that it ran. */
    const nested = join(repo, "sub", ".git");
    rmSync(nested);
    cpSync(join(repo, ".git", "modules", "sub"), nested, { recursive: true });
    const config = readFileSync(join(nested, "config"), "utf8").split("\n").filter((line) => !line.includes("worktree")).join("\n");
    writeFileSync(join(nested, "config"), config);
    const evil = join(root, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\necho ran >> "${marker}"\nexit 0\n`, { mode: 0o755 });
    git(join(repo, "sub"), "config", "filter.evil.clean", evil);
    writeFileSync(join(repo, "sub", ".gitattributes"), "* filter=evil\n");
    writeFileSync(join(repo, "sub", "f.txt"), "b\n"); /* same size, new content: git must run the filter to compare it */
    writeFileSync(join(repo, "generated.test.js"), "// a test the agent wrote\n");

    const changes = gitWorkingChanges(repo);

    assert.ok(changes.includes("generated.test.js"), "the test the agent wrote is listed");
    assert.equal(existsSync(marker), false, "the submodule's filter driver did not run as the orchestrator");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* A child script printing output whose final `keep` chars begin `cutOffset` chars into the secret's own line, then failing:
   the tail the runner keeps is cut through the secret. The secret travels base64-encoded so it is not in argv. */
function scriptCuttingThroughSecret(keep: number, secret: string, cutOffset: number): string {
  return [
    `const keep = ${keep}, secret = Buffer.from('${Buffer.from(secret).toString("base64")}', 'base64').toString(), off = ${cutOffset};`,
    "const line = 'token=' + secret + '\\n';",
    "const suffix = keep - (line.length - (6 + off));",
    "const q = Math.floor(suffix / 4), r = suffix - 4 * q;",
    "process.stdout.write('filler\\n'.repeat(50) + line + 'ctx\\n'.repeat(q - 1) + 'y'.repeat(r + 3) + '\\n');",
    "process.exitCode = 1;",
  ].join(" ");
}

test("a secret cut through by the kept-output bound never reaches the reported logs or the failure detail", { timeout: 30_000 }, async () => {
  const secret = "ghp_" + "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"; /* 40 chars */
  const leakedHalf = secret.slice(-20);
  const deps = { ...createDefaultCodeExecuteDeps(null), detect: () => nodeTest(scriptCuttingThroughSecret(CODE_TEST_OUTPUT_KEEP_CHARS, secret, 20)), listWrites: () => [] };

  const result = await runCodeTests(tmpdir(), { namespace: "run-1" }, deps);

  assert.equal(result.verdict, "fail");
  assert.ok(result.logs.includes("ctx"), "the output around the cut line did reach the logs");
  assert.ok(!result.logs.includes(leakedHalf), "the back half of the cut secret is not in the logs");
  const detail = result.cases[0]?.detail ?? "";
  assert.ok(detail.includes("ctx"), "the failure detail carries the surrounding output");
  assert.ok(!detail.includes(leakedHalf), "the back half of the cut secret is not in the Issue-bound failure detail");
});

/* A suite's evidence that tests ran can sit in the part of the output the kept-output bound drops: a Go `ok` line for an
   early package, a Rust or Maven test count printed before a long tail of quieter output. A passing suite must not read
   as "executed zero tests" (an inconclusive infra-error) because of how much it printed after that. */
const NOISY_TAILS = [
  { ecosystem: "go" as const, evidence: "ok  \\tgithub.com/acme/app/core\\t0.012s\\n", filler: "?   \\tgithub.com/acme/app/gen\\t[no test files]\\n" },
  { ecosystem: "rust" as const, evidence: "running 5 tests\\n", filler: "running 0 tests\\n" },
  { ecosystem: "maven" as const, evidence: "Tests run: 3, Failures: 0, Errors: 0, Skipped: 0\\n", filler: "[INFO] noisy plugin output line to push the evidence out\\n" },
];

for (const { ecosystem, evidence, filler } of NOISY_TAILS) {
  test(`a passing ${ecosystem} suite that printed its test evidence before a long tail is still a pass`, { timeout: 30_000 }, async () => {
    const script =
      `process.stdout.write('${evidence}');` +
      `const chunk = '${filler}'.repeat(10000);` +
      "let written = 0;" +
      "(function go() { if (written++ < 30) return process.stdout.write(chunk, go); process.stdout.write('done\\n'); })();";
    const project: CodeProject = { ecosystem, install: null, test: { cmd: process.execPath, args: ["-e", script] } };
    const deps = { ...createDefaultCodeExecuteDeps(null), detect: () => project, listWrites: () => [] };

    const result = await runCodeTests(tmpdir(), { namespace: "run-1" }, deps);

    assert.equal(result.verdict, "pass", `the suite passed; the evidence line is far outside the kept output (${result.logs.length} chars kept)`);
    assert.ok(result.logs.includes("done"), "the newest output is still kept");
  });
}
