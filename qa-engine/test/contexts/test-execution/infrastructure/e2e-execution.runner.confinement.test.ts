/* The Playwright child runs the repo's specs, which are code the agent wrote, and it knows both directories the runner makes for it: the one that holds the JSON report (PLAYWRIGHT_JSON_OUTPUT_NAME) and the one the failure-capture fixture writes its dumps to (QA_FAILURE_CAPTURE_DIR). It can leave a named pipe, a link or a file of any size where the runner reads back, and a read that waited on the pipe would hold the whole single-threaded orchestrator on every e2e run. The report and the dumps go through the strict read of spec-path-confinement under a cap. A report that cannot be read leaves the run without a result, which is infrastructure and never a pass; a dump that cannot be read leaves its case without grounding, said once for the directory in words that quote nothing the file holds and name no file. Every case runs against real files, links and pipes under os.tmpdir(); the pipe cases run under the watch of test/support/named-pipe-watch.ts. */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  FAILURE_DUMP_LIMITS,
  MAX_FAILURE_DUMP_BYTES,
  MAX_FAILURE_DUMP_FILES,
  MAX_FAILURE_DUMPS_TOTAL_BYTES,
  MAX_PLAYWRIGHT_REPORT_BYTES,
  createDefaultE2eExecuteDeps,
  readFailureDumps,
  readPlaywrightReport,
  runE2E,
  type E2eExecuteDeps,
  type E2eRunOutput,
} from "@contexts/test-execution/infrastructure/e2e-execution.runner.ts";
import { ProcessKillAdapter } from "../../../../src/shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { watchNamedPipe, withoutWaitingOnNamedPipe } from "../../../support/named-pipe-watch.ts";

const SECRET = "SECRET-OUTSIDE-THE-MIRROR-0451";
const PASSING_REPORT = JSON.stringify({ suites: [{ title: "login.spec.ts", specs: [{ title: "ok", tests: [{ status: "expected", results: [{ status: "passed" }] }] }] }], stats: { expected: 1, unexpected: 0 } });
const FAILING_REPORT = {
  suites: [{ title: "login.spec.ts", specs: [{ title: "shows the dashboard", ok: false, tests: [{ results: [{ status: "failed", error: { message: "x" } }] }] }] }],
  stats: { expected: 0, unexpected: 1 },
};
const dumpBody = (yaml: string, retry = 0): string => JSON.stringify({ project: "chromium", file: "login.spec.ts", title: "shows the dashboard", retry, yaml });

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-e2e-runner-fifo-probe-"));
  try {
    execFileSync("mkfifo", [join(dir, "probe")]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_NAMED_PIPES = canMakeNamedPipes() ? false : "mkfifo is not available on this platform, so the named-pipe cases are not exercised";
const NO_MODE_RESTRICTIONS = process.platform === "win32" || process.getuid?.() === 0 ? "the account that runs the tests is not bound by file modes, so the cases that rely on them are not exercised" : false;

function withDir<T>(run: (dir: string, outside: string) => T | Promise<T>): Promise<T> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-e2e-runner-confined-"));
  const dir = join(tmp, "dir");
  const outside = join(tmp, "outside");
  mkdirSync(dir);
  mkdirSync(outside);
  return Promise.resolve(run(dir, outside)).finally(() => rmSync(tmp, { recursive: true, force: true }));
}

/* What the runner says on the way, which goes to logs and to Issues. */
async function capturing<T>(run: () => T | Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    return { value: await run(), warnings };
  } finally {
    warn.mock.restore();
  }
}

/* Valid JSON all the way (the text and then whitespace), so that nothing but its size can keep a file from being read. */
const padded = (path: string, text: string, bytes: number): void => {
  const fd = openSync(path, "w");
  try {
    writeSync(fd, text);
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    for (let written = Buffer.byteLength(text); written < bytes; written += chunk.length) writeSync(fd, chunk, 0, Math.min(chunk.length, bytes - written));
  } finally {
    closeSync(fd);
  }
};

/* ── the Playwright JSON report ───────────────────────────────────────────────────────────────── */

test("a report the child left is read whole", async () => {
  await withDir((dir) => {
    writeFileSync(join(dir, "report.json"), PASSING_REPORT);

    const read = readPlaywrightReport(join(dir, "report.json"));

    assert.deepEqual(read, { ran: true, report: JSON.parse(PASSING_REPORT) });
  });
});

test("no report is a run that did not report, and there is nothing to say of a file that is not there", async () => {
  await withDir((dir) => {
    const read = readPlaywrightReport(join(dir, "report.json"));

    assert.deepEqual(read, { ran: false });
  });
});

test("a report that is a named pipe is not read and not waited on, and the run has no result", { skip: NO_NAMED_PIPES }, async () => {
  await withDir(async (dir) => {
    execFileSync("mkfifo", [join(dir, "report.json")]);

    const read = await withoutWaitingOnNamedPipe(join(dir, "report.json"), () => readPlaywrightReport(join(dir, "report.json")));

    assert.equal(read.ran, false);
    assert.ok("reason" in read && read.reason.length > 0, "and it says why");
  });
});

test("a report that is a link is not read, whatever it points at: a passing report the test process wrote elsewhere is no result", async () => {
  await withDir((dir, outside) => {
    writeFileSync(join(outside, "forged.json"), PASSING_REPORT);
    symlinkSync(join(outside, "forged.json"), join(dir, "report.json"));

    const read = readPlaywrightReport(join(dir, "report.json"));

    assert.equal(read.ran, false);
    assert.ok("reason" in read && read.reason.length > 0);
  });
});

test("a directory in the place of the report is no report", async () => {
  await withDir((dir) => {
    mkdirSync(join(dir, "report.json"));

    const read = readPlaywrightReport(join(dir, "report.json"));

    assert.equal(read.ran, false);
    assert.ok("reason" in read && read.reason.length > 0);
  });
});

test("a report of exactly the cap is read and one byte more is not, whatever it holds", async () => {
  await withDir((dir) => {
    const cap = PASSING_REPORT.length + 10;
    padded(join(dir, "report.json"), PASSING_REPORT, cap);
    const exact = readPlaywrightReport(join(dir, "report.json"), cap);
    padded(join(dir, "report.json"), PASSING_REPORT, cap + 1);
    const over = readPlaywrightReport(join(dir, "report.json"), cap);

    assert.equal(exact.ran, true);
    assert.equal(over.ran, false);
    assert.ok("reason" in over && over.reason.length > 0);
  });
});

test("a report over the production cap is refused without being read", async () => {
  await withDir((dir) => {
    padded(join(dir, "report.json"), PASSING_REPORT, MAX_PLAYWRIGHT_REPORT_BYTES + 1);

    const read = readPlaywrightReport(join(dir, "report.json"));

    assert.equal(read.ran, false);
    assert.ok("reason" in read && read.reason.length > 0);
  });
});

test("the cap on a report holds the largest report a real suite makes and stays far below what a parse cannot take: a thousand tests that fail on all three attempts, each with a 4 KB message, fit", async () => {
  const MIB = 1024 * 1024;
  const failing = (i: number) => ({ title: `case ${i}`, ok: false, tests: [{ results: [0, 1, 2].map(() => ({ status: "failed", error: { message: "x".repeat(4096) }, duration: 1234 })) }] });
  const report = JSON.stringify({ suites: [{ title: "big.spec.ts", specs: Array.from({ length: 1000 }, (_, i) => failing(i)) }], stats: { expected: 0, unexpected: 1000 } });

  assert.ok(report.length > 10 * MIB && report.length < MAX_PLAYWRIGHT_REPORT_BYTES, `${report.length} bytes against a cap of ${MAX_PLAYWRIGHT_REPORT_BYTES}`);
  /* A document of empty arrays costs some fifteen times its size in heap and a second of parse for every 12 MiB, so a cap in the hundreds of megabytes is a freeze and an out-of-memory in waiting. */
  assert.ok(MAX_PLAYWRIGHT_REPORT_BYTES <= 16 * MIB, `${MAX_PLAYWRIGHT_REPORT_BYTES} bytes`);
});

test("a report that is not JSON is no result, said without quoting what it holds", async () => {
  await withDir((dir) => {
    writeFileSync(join(dir, "report.json"), `${SECRET} { not json`);

    const read = readPlaywrightReport(join(dir, "report.json"));

    assert.equal(read.ran, false);
    assert.ok("reason" in read && read.reason.length > 0 && !read.reason.includes(SECRET), `the reason quotes nothing: ${JSON.stringify(read)}`);
  });
});

test("a report that cannot be read is no result, said by the failure's code", { skip: NO_MODE_RESTRICTIONS }, async () => {
  await withDir((dir) => {
    writeFileSync(join(dir, "report.json"), PASSING_REPORT);
    chmodSync(join(dir, "report.json"), 0o000);
    try {
      const read = readPlaywrightReport(join(dir, "report.json"));

      assert.deepEqual(read, { ran: false, reason: "EACCES" });
    } finally {
      chmodSync(join(dir, "report.json"), 0o644);
    }
  });
});

/* The real runner spawns `npx playwright ...`. A stand-in `npx` first on PATH plays Playwright, so the process boundary (pipes, exit) is real while no browser is needed. The stand-in leaves what the case needs at the path the runner handed it and then waits for the test to say "go", so that the test can put the watch on the path before the runner reads it. */
async function withStandInPlaywright<T>(script: string, body: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "stand-in-npx-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "playwright.cjs"), `const fs = require("node:fs"); const path = require("node:path"); const { execFileSync } = require("node:child_process");\nconst out = process.env.PLAYWRIGHT_JSON_OUTPUT_NAME;\nconst announce = () => { fs.writeFileSync(path.join(__dirname, "report-path.txt"), out); const until = Date.now() + 15000; while (!fs.existsSync(path.join(__dirname, "go")) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); };\n${script}`);
  writeFileSync(join(bin, "npx"), `#!/bin/sh\nexec "${process.execPath}" "${join(root, "playwright.cjs")}" "$@"\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    return await body(root);
  } finally {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
}

async function until<T>(probe: () => T | undefined, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("the stand-in never announced the report path");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a report the child left is the result of the run: its case is read and the verdict follows it", { timeout: 60_000 }, async () => {
  await withStandInPlaywright(`fs.writeFileSync(out, ${JSON.stringify(PASSING_REPORT)});`, async (root) => {
    const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 30_000, join(root, "auth"));

    const run = await runE2E(root, { baseUrl: "http://localhost", namespace: "ns" }, deps);

    assert.equal(run.verdict, "pass");
    assert.deepEqual(run.cases.map((c) => c.status), ["pass"]);
  });
});

test("a report the child replaced by a named pipe after it wrote it is not waited on: the run has no result and says why, and is infrastructure, never a pass", { skip: NO_NAMED_PIPES, timeout: 60_000 }, async () => {
  await withStandInPlaywright(`fs.writeFileSync(out, ${JSON.stringify(PASSING_REPORT)}); fs.rmSync(out); execFileSync("mkfifo", [out]); announce();`, async (root) => {
    const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 30_000, join(root, "auth"));
    const running = runE2E(root, { baseUrl: "http://localhost", namespace: "ns" }, deps);
    const reportPath = await until(() => (existsSync(join(root, "report-path.txt")) ? readFileSync(join(root, "report-path.txt"), "utf8") : undefined));
    const watch = watchNamedPipe(reportPath);
    writeFileSync(join(root, "go"), "");

    const run = await running;

    assert.equal(watch.stop(), false, "the orchestrator did not open the pipe");
    assert.equal(run.verdict, "infra-error");
    assert.equal(run.passed, false);
    assert.deepEqual(run.cases, []);
  });
});

test("a report the child replaced by a link to a passing report is no result: the run is infrastructure, never a pass", { timeout: 60_000 }, async () => {
  await withStandInPlaywright(`const outside = path.join(__dirname, "forged.json"); fs.writeFileSync(outside, ${JSON.stringify(PASSING_REPORT)}); fs.rmSync(out, { force: true }); fs.symlinkSync(outside, out);`, async (root) => {
    const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 30_000, join(root, "auth"));

    const run = await runE2E(root, { baseUrl: "http://localhost", namespace: "ns" }, deps);

    assert.equal(run.verdict, "infra-error");
    assert.equal(run.passed, false);
  });
});

test("a report over the production cap makes a run with no result: the cap the runner reads with is the one that is tested", { timeout: 60_000 }, async () => {
  const megabytes = MAX_PLAYWRIGHT_REPORT_BYTES / (1024 * 1024);
  await withStandInPlaywright(`const fd = fs.openSync(out, "w"); fs.writeSync(fd, ${JSON.stringify(PASSING_REPORT)}); const chunk = Buffer.alloc(1048576, 32); for (let i = 0; i < ${megabytes}; i++) fs.writeSync(fd, chunk); fs.closeSync(fd);`, async (root) => {
    const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 30_000, join(root, "auth"));

    const run = await runE2E(root, { baseUrl: "http://localhost", namespace: "ns" }, deps);

    assert.equal(run.verdict, "infra-error");
    assert.equal(run.passed, false);
  });
});

test("a run whose child left no report at all has the logs of its child and nothing added: there is no refusal to say", { timeout: 60_000 }, async () => {
  await withStandInPlaywright(`process.stderr.write("browser crashed\\n");`, async (root) => {
    const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 30_000, join(root, "auth"));

    const output = await deps.runSuite({ dir: root, baseUrl: "http://localhost", namespace: "ns" });

    assert.equal(output.ran, false);
    assert.equal(output.logs, "browser crashed\n");
  });
});

test("the logs of a run whose report was refused say that it was, with the reason of the refusal and nothing the report held", { timeout: 60_000 }, async () => {
  await withStandInPlaywright(`fs.writeFileSync(out, ${JSON.stringify(`${SECRET} `.repeat(4))}); fs.rmSync(out); fs.mkdirSync(out);`, async (root) => {
    const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 30_000, join(root, "auth"));

    const output = await deps.runSuite({ dir: root, baseUrl: "http://localhost", namespace: "ns" });

    assert.equal(output.ran, false);
    /* The reason the strict read gives for a directory where the report should be, asked of a directory of the test's own. */
    const control = await withDir((dir) => {
      mkdirSync(join(dir, "report.json"));
      return readPlaywrightReport(join(dir, "report.json"));
    });
    assert.ok("reason" in control && control.reason.length > 0, "the control: a directory is refused with a reason");
    assert.ok(output.logs.includes((control as { reason: string }).reason), `the logs give the reason: ${output.logs}`);
    assert.ok(!output.logs.includes(SECRET));
  });
});

/* ── how the child ended ──────────────────────────────────────────────────────────────────────── */

/* The report is written by the test process, so a report that says every test passed cannot be told from a forged one by what it holds. How the child ended can: Playwright exits non-zero when a test failed, and a child ended by a signal never finished reporting. */
const PASSING_RUN: E2eRunOutput = { report: JSON.parse(PASSING_REPORT), logs: "", ran: true };
const runWith = (out: E2eRunOutput) => runE2E("/spec", { baseUrl: "http://localhost", namespace: "ns" }, { runSuite: async () => out });

test("a report that says every test passed, from a child that exited with a failure status, is no pass: it is infrastructure and says why", async () => {
  for (const exitCode of [1, 2, 137]) {
    const run = await runWith({ ...PASSING_RUN, exitCode });

    assert.equal(run.verdict, "infra-error", `exit ${exitCode}`);
    assert.equal(run.passed, false);
    assert.ok(run.logs.includes(String(exitCode)), `the logs give the status: ${run.logs}`);
  }
});

test("a report that says every test passed, from a child that a signal ended, is no pass", async () => {
  const run = await runWith({ ...PASSING_RUN, signal: "SIGKILL" });

  assert.equal(run.verdict, "infra-error");
  assert.equal(run.passed, false);
  assert.ok(run.logs.includes("SIGKILL"), `the logs give the signal: ${run.logs}`);
});

test("a report that says every test passed, from a child that exited 0 or whose status nobody gave, is a pass as it was", async () => {
  assert.equal((await runWith({ ...PASSING_RUN, exitCode: 0 })).verdict, "pass");
  assert.equal((await runWith(PASSING_RUN)).verdict, "pass", "a runner that tells nothing of the exit is not accused of one");
});

test("a report of failures is a fail whatever the exit status: the status only takes a pass away", async () => {
  const failing = { report: FAILING_REPORT, logs: "", ran: true };

  assert.equal((await runWith({ ...failing, exitCode: 1 })).verdict, "fail");
  assert.equal((await runWith({ ...failing, exitCode: 0 })).verdict, "fail", "a failure the child did not exit for is still a failure");
  assert.equal((await runWith({ ...failing, signal: "SIGTERM" })).verdict, "fail");
});

test("the child that exits with a failure status after writing a passing report makes a run that is not a pass, through the real runner", { timeout: 60_000 }, async () => {
  await withStandInPlaywright(`fs.writeFileSync(out, ${JSON.stringify(PASSING_REPORT)}); process.exit(1);`, async (root) => {
    const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 30_000, join(root, "auth"));

    const run = await runE2E(root, { baseUrl: "http://localhost", namespace: "ns" }, deps);

    assert.equal(run.verdict, "infra-error");
    assert.equal(run.passed, false);
  });
});

test("the child that a signal ends after writing a passing report makes a run that is not a pass, through the real runner", { timeout: 60_000 }, async () => {
  await withStandInPlaywright(`fs.writeFileSync(out, ${JSON.stringify(PASSING_REPORT)}); process.kill(process.pid, "SIGKILL");`, async (root) => {
    const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 30_000, join(root, "auth"));

    const run = await runE2E(root, { baseUrl: "http://localhost", namespace: "ns" }, deps);

    assert.equal(run.verdict, "infra-error");
    assert.equal(run.passed, false);
  });
});

/* Resolves once the runner has removed the directory it made for the run, which it does when the child is gone. */
async function untilRunnerCleanedUp(root: string): Promise<void> {
  const reportPath = await until(() => (existsSync(join(root, "report-path.txt")) ? readFileSync(join(root, "report-path.txt"), "utf8") : undefined));
  const deadline = Date.now() + 15_000;
  while (existsSync(dirname(reportPath))) {
    if (Date.now() > deadline) throw new Error("the runner never cleaned up after the child");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("the report of a child that exited is read once, by the path the runner handed it", { timeout: 60_000 }, async () => {
  await withStandInPlaywright(`fs.writeFileSync(out, ${JSON.stringify(PASSING_REPORT)}); fs.writeFileSync(path.join(__dirname, "report-path.txt"), out);`, async (root) => {
    const reads: string[] = [];
    const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 30_000, join(root, "auth"), undefined, (path) => { reads.push(path); return readPlaywrightReport(path); });

    const run = await runE2E(root, { baseUrl: "http://localhost", namespace: "ns" }, deps);

    assert.equal(run.verdict, "pass");
    assert.equal(reads.length, 1);
    assert.equal(basename(reads[0]!), "report.json");
  });
});

test("the report of a child that outlived the deadline of the run is not read: nobody waits for it, and a report made slow to parse costs nothing once the run is over", { timeout: 60_000 }, async () => {
  await withStandInPlaywright(`fs.writeFileSync(out, ${JSON.stringify(PASSING_REPORT)}); announce();`, async (root) => {
    const reads: string[] = [];
    const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 30_000, join(root, "auth"), undefined, (path) => { reads.push(path); return readPlaywrightReport(path); });

    /* A deadline far enough for the stand-in to start and write its report on a machine that is running the whole suite, and near enough for the test not to wait long. */
    const run = await runE2E(root, { baseUrl: "http://localhost", namespace: "ns", timeoutMs: 4_000 }, deps);
    await untilRunnerCleanedUp(root);

    assert.equal(run.verdict, "infra-error", "the run timed out");
    assert.match(run.logs, /timed out/);
    assert.deepEqual(reads, [], "the child was killed and closed, and its report was left alone");
  });
});

test("the report of a child that the operator cancelled is not read either", { timeout: 60_000 }, async () => {
  await withStandInPlaywright(`fs.writeFileSync(out, ${JSON.stringify(PASSING_REPORT)}); announce();`, async (root) => {
    const reads: string[] = [];
    const deps = createDefaultE2eExecuteDeps(new ProcessKillAdapter(), 30_000, join(root, "auth"), undefined, (path) => { reads.push(path); return readPlaywrightReport(path); });
    const controller = new AbortController();

    const running = runE2E(root, { baseUrl: "http://localhost", namespace: "ns", signal: controller.signal }, deps);
    await until(() => (existsSync(join(root, "report-path.txt")) ? true : undefined));
    controller.abort();
    const run = await running;
    await untilRunnerCleanedUp(root);

    assert.equal(run.verdict, "infra-error");
    assert.deepEqual(reads, []);
  });
});

/* ── the failure-capture dumps ────────────────────────────────────────────────────────────────── */

test("dumps are read whole, the way the fixture writes them", async () => {
  await withDir((dir) => {
    writeFileSync(join(dir, "chromium__aaa__0.json"), dumpBody("- button"));
    writeFileSync(join(dir, "chromium__aaa__1.json"), dumpBody("- link", 1));
    writeFileSync(join(dir, "note.txt"), "not a dump");

    const dumps = readFailureDumps(dir);

    assert.deepEqual(dumps.map((d) => [d.retry, d.yaml]), [[0, "- button"], [1, "- link"]]);
  });
});

test("only a file named like the fixture's dump is a dump: the name ends in the retry and `.json`", async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, "chromium__aaa__0.json"), dumpBody("- dump"));
    writeFileSync(join(dir, "chromium__aaa__0.json.tmp"), dumpBody("- a temporary file"));
    writeFileSync(join(dir, "chromium__aaa__0.jsonl"), dumpBody("- another file"));
    writeFileSync(join(dir, "chromium__aaa.json"), dumpBody("- no retry in the name"));

    const dumps = readFailureDumps(dir);

    assert.deepEqual(dumps.map((d) => d.yaml), ["- dump"]);
  });
});

test("a retry the dump does not carry is the number in its name, however many digits it has", async () => {
  await withDir(async (dir) => {
    const withoutRetry = (yaml: string): string => JSON.stringify({ project: "chromium", file: "login.spec.ts", title: "shows the dashboard", yaml });
    writeFileSync(join(dir, "chromium__aaa__12.json"), withoutRetry("- twelve"));
    writeFileSync(join(dir, "chromium__bbb__3.json"), JSON.stringify({ project: "chromium", retry: "three", yaml: "- three" }));

    const dumps = readFailureDumps(dir);

    assert.deepEqual(dumps.map((d) => [d.yaml, d.retry]), [["- twelve", 12], ["- three", 3]]);
  });
});

test("a dump whose project or title is not text is read with an empty one, and still stands for its case", async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, "chromium__aaa__0.json"), JSON.stringify({ project: 5, title: null, file: "login.spec.ts", retry: 0, yaml: "- odd" }));

    const dumps = readFailureDumps(dir);

    assert.deepEqual(dumps.map((d) => [d.project, d.title, d.yaml]), [["", "", "- odd"]]);
  });
});

test("a dump that is a named pipe is not read and not waited on, the dumps beside it are, and the warning names no file", { skip: NO_NAMED_PIPES }, async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, "chromium__good__0.json"), dumpBody("- button"));
    execFileSync("mkfifo", [join(dir, "chromium__planted__0.json")]);

    const { value: dumps, warnings } = await withoutWaitingOnNamedPipe(join(dir, "chromium__planted__0.json"), () => capturing(() => readFailureDumps(dir)));

    assert.deepEqual(dumps.map((d) => d.yaml), ["- button"], "the dump beside the pipe is still read: each stands for its own case");
    assert.equal(warnings.length, 1);
    assert.ok(/\b1 /.test(warnings[0]!), `the warning says how many: ${warnings[0]}`);
    assert.ok(!warnings[0]!.includes("planted") && !warnings[0]!.includes("good"), "and names no file");
  });
});

test("a dump that is a link is not read, whatever it points at, and nothing of the file behind it is in a case or in a log", async () => {
  await withDir(async (dir, outside) => {
    writeFileSync(join(outside, "dump.json"), dumpBody(`- heading "${SECRET}"`));
    symlinkSync(join(outside, "dump.json"), join(dir, "chromium__linked__0.json"));

    const { value: dumps, warnings } = await capturing(() => readFailureDumps(dir));

    assert.deepEqual(dumps, []);
    assert.equal(warnings.length, 1);
    assert.ok(!warnings.join("\n").includes(SECRET) && !warnings[0]!.includes("linked"));
  });
});

test("a directory named like a dump is not a dump", async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, "chromium__dir__0.json"));
    writeFileSync(join(dir, "chromium__ok__0.json"), dumpBody("- ok"));

    const { value: dumps, warnings } = await capturing(() => readFailureDumps(dir));

    assert.deepEqual(dumps.map((d) => d.yaml), ["- ok"]);
    assert.equal(warnings.length, 1);
  });
});

test("a dump that is not JSON is left out, said aloud, and the parser's quote of it is not in the log", async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, "chromium__corrupt__0.json"), `${SECRET} {not json`);
    writeFileSync(join(dir, "chromium__ok__0.json"), dumpBody("- ok"));

    const { value: dumps, warnings } = await capturing(() => readFailureDumps(dir));

    assert.deepEqual(dumps.map((d) => d.yaml), ["- ok"]);
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0]!.includes("SECRET") && !warnings[0]!.includes("corrupt"), `a parser's message quotes the file: ${warnings[0]}`);
  });
});

test("a dump that cannot be read is left out, said by the failure's code", { skip: NO_MODE_RESTRICTIONS }, async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, "chromium__locked__0.json"), dumpBody("- locked"));
    chmodSync(join(dir, "chromium__locked__0.json"), 0o000);
    try {
      const { value: dumps, warnings } = await capturing(() => readFailureDumps(dir));

      assert.deepEqual(dumps, []);
      assert.ok(warnings[0]!.includes("EACCES"), warnings[0]);
    } finally {
      chmodSync(join(dir, "chromium__locked__0.json"), 0o644);
    }
  });
});

test("a dump over the cap is not read, and one of exactly the cap is", async () => {
  await withDir(async (dir) => {
    const body = dumpBody("- fits");
    const limits = { maxFileBytes: Buffer.byteLength(body), maxTotalBytes: Buffer.byteLength(body) * 10, maxFiles: 10 };
    writeFileSync(join(dir, "chromium__exact__0.json"), body);
    writeFileSync(join(dir, "chromium__over__1.json"), `${body} `);

    const { value: dumps, warnings } = await capturing(() => readFailureDumps(dir, limits));

    assert.deepEqual(dumps.map((d) => d.yaml), ["- fits"]);
    assert.equal(warnings.length, 1);
  });
});

test("a dump over the production cap is left out without being read, and one of exactly the cap is read", async () => {
  await withDir(async (dir) => {
    padded(join(dir, "chromium__exact__0.json"), dumpBody("- exact"), MAX_FAILURE_DUMP_BYTES);
    padded(join(dir, "chromium__huge__1.json"), dumpBody("- huge", 1), MAX_FAILURE_DUMP_BYTES + 1);
    writeFileSync(join(dir, "chromium__ok__2.json"), dumpBody("- ok", 2));

    const { value: dumps } = await capturing(() => readFailureDumps(dir));

    assert.deepEqual(dumps.map((d) => d.yaml), ["- exact", "- ok"]);
  });
});

test("the dumps are read until their total would pass the budget, and the rest are left out, said once", async () => {
  await withDir(async (dir) => {
    const body = dumpBody("- x");
    const size = Buffer.byteLength(body);
    for (const name of ["a", "b", "c", "d"]) writeFileSync(join(dir, `chromium__${name}__0.json`), body);

    const { value: dumps, warnings } = await capturing(() => readFailureDumps(dir, { maxFileBytes: size, maxTotalBytes: size * 3, maxFiles: 10 }));

    assert.equal(dumps.length, 3, "a total of exactly the budget is read");
    assert.equal(warnings.length, 1);
    assert.ok(/\b1 /.test(warnings[0]!), warnings[0]);
  });
});

test("the production budget bounds the dumps of a run together: the dumps that fit are read, the first that would pass it and the rest are left out unread, said once", async () => {
  await withDir(async (dir) => {
    assert.ok(MAX_FAILURE_DUMP_BYTES >= 1024 * 1024, "a dump of a failed page is some hundreds of kilobytes, and the cap is not below a megabyte");
    const fit = Math.floor(MAX_FAILURE_DUMPS_TOTAL_BYTES / MAX_FAILURE_DUMP_BYTES);
    assert.ok(fit >= 1 && fit <= 1024, `${fit} dumps of the largest size fit the budget: the cases below make that many files`);
    for (let i = 0; i <= fit; i++) {
      const path = join(dir, `chromium__d${String(i).padStart(3, "0")}__0.json`);
      writeFileSync(path, "");
      truncateSync(path, MAX_FAILURE_DUMP_BYTES); /* a file of zeros: its size is what the budget counts, and it is no JSON */
    }

    const { value: dumps, warnings } = await capturing(() => readFailureDumps(dir));

    assert.deepEqual(dumps, []);
    assert.equal(warnings.length, 1);
    assert.deepEqual([...warnings[0]!.matchAll(/×(\d+)/g)].map((m) => Number(m[1])), [fit, 1], `${fit} dumps fit and could not be used, one is over the budget: ${warnings[0]}`);
  });
});

test("a directory with more entries than the cap is read up to it, said once with how many were looked at", async () => {
  await withDir(async (dir) => {
    const body = dumpBody("- x");
    const size = Buffer.byteLength(body);
    for (const name of ["a", "b", "c"]) writeFileSync(join(dir, `chromium__${name}__0.json`), body);

    const exact = await capturing(() => readFailureDumps(dir, { maxFileBytes: size, maxTotalBytes: size * 10, maxFiles: 3 }));
    const cut = await capturing(() => readFailureDumps(dir, { maxFileBytes: size, maxTotalBytes: size * 10, maxFiles: 2 }));

    assert.equal(exact.value.length, 3);
    assert.deepEqual(exact.warnings, []);
    assert.equal(cut.value.length, 2, "what was looked at is read");
    assert.equal(cut.warnings.length, 1);
    assert.ok(/\b2 entries\b/.test(cut.warnings[0]!), cut.warnings[0]);
  });
});

test("thousands of dumps that cannot be used make one line in the log, not one each", async () => {
  await withDir(async (dir) => {
    for (let i = 0; i < 3_000; i++) writeFileSync(join(dir, `f${i}__0.json`), "");

    const { value: dumps, warnings } = await capturing(() => readFailureDumps(dir));

    assert.deepEqual(dumps, []);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.length < 600, "and the line is bounded");
  });
});

test("a directory that is a link yields no dumps and says so", async () => {
  await withDir(async (dir, outside) => {
    mkdirSync(join(outside, "dumps"));
    writeFileSync(join(outside, "dumps", "chromium__x__0.json"), dumpBody(`- heading "${SECRET}"`));
    symlinkSync(join(outside, "dumps"), join(dir, "linked"));

    const { value: dumps, warnings } = await capturing(() => readFailureDumps(join(dir, "linked")));

    assert.deepEqual(dumps, []);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes(join(dir, "linked")), `the warning names the directory: ${warnings[0]}`);
    assert.ok(!warnings[0]!.includes(SECRET));
  });
});

test("a directory the child removed has no dumps, and that is said: the runner made it, so its absence is not the usual one", async () => {
  await withDir(async (dir) => {
    const { value: dumps, warnings } = await capturing(() => readFailureDumps(join(dir, "gone")));

    assert.deepEqual(dumps, []);
    assert.equal(warnings.length, 1);
  });
});

test("a directory with no dump in it has nothing to say", async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, "note.txt"), "not a dump");

    const { value: dumps, warnings } = await capturing(() => readFailureDumps(dir));

    assert.deepEqual([dumps, warnings], [[], []]);
  });
});

test("the production limits are the ones the cases above rely on", () => {
  assert.equal(FAILURE_DUMP_LIMITS.maxFileBytes, MAX_FAILURE_DUMP_BYTES);
  assert.equal(FAILURE_DUMP_LIMITS.maxFiles, MAX_FAILURE_DUMP_FILES);
  assert.equal(FAILURE_DUMP_LIMITS.maxTotalBytes, MAX_FAILURE_DUMPS_TOTAL_BYTES);
  assert.ok(MAX_FAILURE_DUMPS_TOTAL_BYTES >= MAX_FAILURE_DUMP_BYTES, "the budget holds at least one dump of the largest size");
  /* Every dump is parsed in the orchestrator's one thread, and a dump of nothing but empty arrays takes a second for every 12 MiB, so what all of them may hold together is what a freeze can last. A failed case leaves one dump of some hundreds of kilobytes. */
  assert.ok(MAX_FAILURE_DUMPS_TOTAL_BYTES <= 32 * 1024 * 1024, `${MAX_FAILURE_DUMPS_TOTAL_BYTES} bytes`);
});

/* What the harvest comes to for the run: a dump the test process planted never changes the verdict, and the failed case it would have grounded runs without grounding. */
function reportOf(dumpName: string, plant: (failureCaptureDir: string) => void): E2eExecuteDeps {
  return {
    runSuite: async (args) => {
      if (args.failureCaptureDir) plant(join(args.failureCaptureDir, dumpName));
      return { report: FAILING_REPORT, logs: "failed", ran: true };
    },
  };
}

test("a failure dump that is a named pipe does not hold the run: the case fails as it did and runs without grounding", { skip: NO_NAMED_PIPES, timeout: 60_000 }, async () => {
  let watch: { stop(): boolean } | undefined;
  const deps = reportOf("chromium__planted__0.json", (path) => {
    execFileSync("mkfifo", [path]);
    watch = watchNamedPipe(path);
  });

  const { value: run, warnings } = await capturing(() => runE2E("/e2e", { baseUrl: "https://dev", namespace: "ns" }, deps));

  assert.equal(watch?.stop(), false, "the orchestrator did not open the pipe");
  assert.equal(run.verdict, "fail");
  assert.equal(run.cases.find((c) => c.status === "fail")?.failureDom, undefined);
  assert.ok(warnings.some((w) => w.includes("no failure-point DOM captured")), "the case says it has no grounding");
});

test("a failure dump that is a link puts nothing of the file behind it in the failed case", async () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "qa-e2e-runner-outside-"));
  try {
    writeFileSync(join(outsideDir, "dump.json"), dumpBody(`- heading "${SECRET}"`));
    const deps = reportOf("chromium__linked__0.json", (path) => symlinkSync(join(outsideDir, "dump.json"), path));

    const { value: run } = await capturing(() => runE2E("/e2e", { baseUrl: "https://dev", namespace: "ns" }, deps));

    assert.equal(run.verdict, "fail");
    assert.equal(run.cases.find((c) => c.status === "fail")?.failureDom, undefined);
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
});
