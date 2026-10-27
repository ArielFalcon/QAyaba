#!/usr/bin/env node
/*
 * Runs the node:test suite in a few shared-process workers instead of one process per test file.
 *
 * `node --test` starts a process per file by default, and each one registers tsx and loads and
 * transpiles its whole module graph again: most of the suite's wall time went into that startup, not
 * into tests. Here the test files are split into N groups, balanced by the cost each file had in an
 * earlier run (scripts/test-timings.json; a file it does not list costs the median), and each group
 * runs in ONE process with `--test-isolation=none`, so a module is loaded once per worker. The split
 * is deterministic: the same files always land in the same worker, in the same order.
 *
 * Every worker preloads test-setup.mjs, so each worker (not each file) gets its own temp history
 * database and log directory and the tracked-tree write guard. Tests in one worker share a process:
 * a test that changes a global (fetch, process.env, a timer, a module-level registry) restores it.
 *
 * usage: node scripts/run-tests.mjs [options] [file or glob...] [node --test flags...]
 *   --workers=N        number of worker processes (default: QA_TEST_WORKERS, else availableParallelism)
 *   --isolated         one process per file (plain `node --test`), the fallback when sharing is in doubt
 *   --record-timings   write each file's measured cost to scripts/test-timings.json after a green run
 *   --verbose          print every worker's full report, not only the failing ones
 * Any other `--flag` (e.g. --test-name-pattern="...") is passed to node --test unchanged; with no
 * file or glob the whole suite runs.
 */
import { spawn } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TIMINGS_FILE = join(ROOT, "scripts", "test-timings.json");
const REPORTER = join(ROOT, "scripts", "test-run-reporter.mjs");
export const DEFAULT_TEST_GLOBS = [
  "src/**/*.test.ts",
  "qa-engine/test/**/*.test.ts",
  "packages/sdk/**/*.test.ts",
  "agents/**/*.test.mjs",
  "scripts/**/*.test.ts",
];
/* Files that need a process of their own, run with node --test's per-file isolation in one more
   worker. Each states what it needs; anything else that fails only in a shared process is a test that
   leaks state, and is fixed by restoring that state, not by joining this list. */
export const ISOLATED_FILES = new Map([
  [
    "src/server/history-db-location.test.ts",
    "the history store resolves its location once per process, on first use: the file sets HISTORY_DB_PATH before that",
  ],
  [
    "src/server/history-db-default-location.test.ts",
    "the history store resolves its location once per process, on first use: the file unsets HISTORY_DB_PATH before that",
  ],
]);
/* The longest a single test may run in a shared worker before it fails by name. Far above any test of the suite (the slowest, the
   prompt-contract matrix, takes about a minute under load), so it only ever ends a test that hangs: a hang in a shared process
   would otherwise hold the whole worker, and the run, with no word of which test it is. */
export const DEFAULT_TEST_TIMEOUT_MS = 300_000;

/* The node --test flags a shared worker runs with: the caller's, plus a bound on each test unless the caller gave one, and an exit once
   the tests end (a handle a test left open must not keep a worker alive after its last test). */
export function workerNodeFlags(nodeFlags) {
  const flags = [...nodeFlags];
  if (!flags.some((f) => f === "--test-timeout" || f.startsWith("--test-timeout="))) flags.push(`--test-timeout=${DEFAULT_TEST_TIMEOUT_MS}`);
  if (!flags.includes("--test-force-exit")) flags.push("--test-force-exit");
  return flags;
}

/* node --test flags that take their value as the next argument when written without `=`. */
const VALUED_FLAGS = new Set([
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-timeout",
  "--test-concurrency",
  "--test-shard",
  "--test-coverage-include",
  "--test-coverage-exclude",
]);

export function parseArgs(argv) {
  const opts = { workers: undefined, isolated: false, recordTimings: false, verbose: false, patterns: [], nodeFlags: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--workers=")) opts.workers = Number(arg.slice("--workers=".length));
    else if (arg === "--isolated") opts.isolated = true;
    else if (arg === "--record-timings") opts.recordTimings = true;
    else if (arg === "--verbose") opts.verbose = true;
    else if (arg.startsWith("--")) {
      opts.nodeFlags.push(arg);
      if (VALUED_FLAGS.has(arg) && i + 1 < argv.length) opts.nodeFlags.push(argv[++i]);
    } else opts.patterns.push(arg);
  }
  if (opts.workers !== undefined && !(Number.isInteger(opts.workers) && opts.workers > 0)) {
    throw new Error(`--workers must be a positive whole number, got ${JSON.stringify(opts.workers)}`);
  }
  return opts;
}

/* The test files the patterns name, repo-relative and sorted; node_modules is never searched. */
export function expandPatterns(patterns, root) {
  const files = new Set();
  for (const pattern of patterns) {
    const matches = /[*?[{]/.test(pattern) ? globSync(pattern, { cwd: root }) : [pattern];
    for (const match of matches) {
      const rel = relative(root, resolve(root, match));
      if (!rel.split(/[\\/]/).includes("node_modules")) files.add(rel);
    }
  }
  return [...files].sort();
}

/* Longest-processing-time-first: each file, costliest first, goes to the group with the least cost so
   far (ties to the lower index). Each group then runs its files in path order. Deterministic. */
export function balance(files, costOf, groups) {
  const bins = Array.from({ length: Math.max(1, Math.min(groups, files.length)) }, () => ({ cost: 0, files: [] }));
  const byCost = [...files].sort((a, b) => costOf(b) - costOf(a) || (a < b ? -1 : 1));
  for (const file of byCost) {
    let target = bins[0];
    for (const bin of bins) if (bin.cost < target.cost) target = bin;
    target.cost += costOf(file);
    target.files.push(file);
  }
  for (const bin of bins) bin.files.sort();
  return bins;
}

function readTimings() {
  try {
    return JSON.parse(readFileSync(TIMINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

/* A file's cost is the time its top-level tests took in an earlier run plus what loading a file costs
   (a shared process does not measure that per file); a file the timings do not list costs their median. */
const FILE_LOAD_MS = 150;
export function costFunction(timings) {
  const known = Object.values(timings).filter((v) => typeof v === "number").sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 0;
  return (file) => FILE_LOAD_MS + (typeof timings[file] === "number" ? timings[file] : fallback);
}

function runIsolated(opts) {
  const files = opts.patterns.length ? opts.patterns : DEFAULT_TEST_GLOBS;
  const args = ["--import", "./test-setup.mjs", "--import", "tsx", "--test", ...opts.nodeFlags, ...files];
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

function runWorker(index, files, nodeFlags, dir, isolated) {
  const specOut = join(dir, `worker-${index}.spec.txt`);
  const jsonOut = join(dir, `worker-${index}.jsonl`);
  const args = [
    "--import", "./test-setup.mjs", "--import", "tsx",
    "--test", isolated ? "--test-isolation=process" : "--test-isolation=none",
    "--test-reporter=spec", `--test-reporter-destination=${specOut}`,
    `--test-reporter=${REPORTER}`, `--test-reporter-destination=${jsonOut}`,
    ...workerNodeFlags(nodeFlags), ...files,
  ];
  const started = performance.now();
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code, signal) => {
      resolveRun({ index, files, code, signal, output, specOut, jsonOut, ms: performance.now() - started });
    });
  });
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/* The spec reporter's failure section, or its tail when the worker died before writing one. */
function failureReport(result) {
  const spec = existsSync(result.specOut) ? readFileSync(result.specOut, "utf8") : "";
  const marker = spec.lastIndexOf("failing tests:");
  const report = marker >= 0 ? spec.slice(spec.lastIndexOf("\n", marker) + 1) : spec.split("\n").slice(-80).join("\n");
  const noise = result.output.trim() ? `\n--- worker output ---\n${result.output.split("\n").slice(-60).join("\n")}` : "";
  return report + noise;
}

async function runShared(opts) {
  const files = expandPatterns(opts.patterns.length ? opts.patterns : DEFAULT_TEST_GLOBS, ROOT);
  if (files.length === 0) {
    console.error("run-tests: no test file matches", opts.patterns.join(" ") || DEFAULT_TEST_GLOBS.join(" "));
    process.exit(1);
  }
  const workers = opts.workers ?? (Number(process.env.QA_TEST_WORKERS) || availableParallelism());
  const shared = files.filter((f) => !ISOLATED_FILES.has(f));
  const isolated = files.filter((f) => ISOLATED_FILES.has(f));
  const bins = shared.length ? balance(shared, costFunction(readTimings()), workers) : [];
  if (isolated.length) bins.push({ cost: 0, files: isolated, isolated: true });
  const dir = mkdtempSync(join(tmpdir(), "qayaba-run-tests-"));
  const started = performance.now();
  console.log(
    `run-tests: ${files.length} files in ${bins.length} workers` +
      (isolated.length ? ` (${isolated.length} file(s) one process each, scripts/run-tests.mjs ISOLATED_FILES)` : ""),
  );
  try {
    const results = await Promise.all(
      bins.map((bin, i) =>
        runWorker(i, bin.files, opts.nodeFlags, dir, bin.isolated === true).then((result) => {
          const tests = readLines(result.jsonOut).filter((e) => !e.suite);
          const failed = tests.filter((t) => !t.ok).length;
          console.log(
            `  worker ${i + 1}/${bins.length}: ${bin.files.length} files, ${tests.length} tests, ${failed} failed, ` +
              `${(result.ms / 1000).toFixed(1)}s${result.code ? ` (exit ${result.code ?? result.signal})` : ""}`,
          );
          return result;
        }),
      ),
    );
    const counts = { tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
    const fileCosts = {};
    const seenFiles = new Set();
    const failing = [];
    for (const result of results) {
      const events = readLines(result.jsonOut);
      const failedHere = events.filter((e) => !e.ok).length;
      for (const e of events) {
        if (e.suite) {
          counts.suites++;
          continue;
        }
        counts.tests++;
        if (e.skip) counts.skipped++;
        else if (e.todo) counts.todo++;
        else if (e.ok) counts.pass++;
        else if (e.cancelled) counts.cancelled++;
        else counts.fail++;
      }
      for (const e of events) {
        if (!e.file) continue;
        const file = relative(ROOT, e.file);
        seenFiles.add(file);
        if (e.nesting === 0) fileCosts[file] = (fileCosts[file] ?? 0) + e.ms;
      }
      if (result.code !== 0 || failedHere > 0 || opts.verbose) failing.push(result);
    }
    /* A file no event names never ran (its worker died first, or it registered no test): say so. */
    const unseen = files.filter((f) => !seenFiles.has(f));
    for (const result of failing) {
      console.log(`\n=== worker ${result.index + 1} (${result.files.length} files) ===`);
      console.log(failureReport(result));
    }
    if (unseen.length) console.log(`\nrun-tests: ${unseen.length} file(s) reported no test:\n  ${unseen.join("\n  ")}`);
    const exitFailed = results.some((r) => r.code !== 0);
    /* The summary node --test prints, line for line, so whatever reads a node:test run's counts reads this one too. */
    console.log("");
    for (const [name, value] of Object.entries(counts)) console.log(`ℹ ${name} ${value}`);
    console.log(`ℹ duration_ms ${(performance.now() - started).toFixed(3)}`);
    const ok = counts.fail === 0 && counts.cancelled === 0 && !exitFailed;
    if (opts.recordTimings) {
      if (!ok) console.log("run-tests: timings not recorded, the run was not green");
      else {
        const sorted = Object.fromEntries(
          Object.entries(fileCosts)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([file, ms]) => [file, Math.round(ms)]),
        );
        writeFileSync(TIMINGS_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
        console.log(`run-tests: recorded ${Object.keys(sorted).length} file timings in ${relative(ROOT, TIMINGS_FILE)}`);
      }
    }
    process.exitCode = ok ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.isolated) runIsolated(opts);
  else await runShared(opts);
}
