import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEST_GLOBS, ISOLATED_FILES, balance, costFunction, expandPatterns, parseArgs } from "./run-tests.mjs";

test("runner options are taken out and every other flag goes to node --test with its value", () => {
  const opts = parseArgs(["--workers=3", "--test-name-pattern", "the login", "src/a.test.ts", "--test-only", "--record-timings"]);

  assert.equal(opts.workers, 3);
  assert.equal(opts.recordTimings, true);
  assert.deepEqual(opts.nodeFlags, ["--test-name-pattern", "the login", "--test-only"]);
  assert.deepEqual(opts.patterns, ["src/a.test.ts"]);
});

test("a worker count that is not a positive whole number is refused", () => {
  assert.throws(() => parseArgs(["--workers=0"]), /--workers/);
  assert.throws(() => parseArgs(["--workers=two"]), /--workers/);
});

test("files are split so the costliest groups stay close, each file in exactly one group, in path order", () => {
  const cost: Record<string, number> = { "a.test.ts": 9, "b.test.ts": 5, "c.test.ts": 4, "d.test.ts": 3, "e.test.ts": 3 };
  const bins = balance(Object.keys(cost), (f) => cost[f] ?? 0, 2);

  assert.deepEqual(bins.map((b) => b.cost).sort(), [12, 12]);
  assert.deepEqual(bins.flatMap((b) => b.files).sort(), Object.keys(cost));
  for (const bin of bins) assert.deepEqual(bin.files, [...bin.files].sort());
});

test("the split is the same on every call, and never makes more groups than files", () => {
  const files = ["x.test.ts", "y.test.ts", "z.test.ts"];
  const flat = () => 1;

  assert.deepEqual(balance(files, flat, 8), balance(files, flat, 8));
  assert.equal(balance(files, flat, 8).length, files.length);
});

test("a file with no recorded timing costs the median of the recorded ones", () => {
  const cost = costFunction({ "a.test.ts": 10, "b.test.ts": 20, "c.test.ts": 1000 });

  assert.equal(cost("new.test.ts") - cost("a.test.ts"), 20 - 10);
});

test("every file kept out of the shared workers exists and says why it needs a process of its own", () => {
  const root = join(import.meta.dirname, "..");
  for (const [file, reason] of ISOLATED_FILES) {
    assert.equal(existsSync(join(root, file)), true, `${file} is listed but does not exist`);
    assert.ok(reason.length > 0, `${file} gives no reason`);
  }
});

/* A shared worker runs a top-level beforeEach/afterEach around the tests of every file in it, so one file's hook
   would reach into the others; hooks live inside a describe. */
test("no test file of the suite registers a per-test hook at its top level", () => {
  const root = join(import.meta.dirname, "..");
  const offenders = expandPatterns(DEFAULT_TEST_GLOBS, root).filter((file) =>
    /^(?:beforeEach|afterEach)\(/m.test(readFileSync(join(root, file), "utf8")),
  );

  assert.deepEqual(offenders, []);
});

test("globs expand to sorted repo-relative files and never reach into node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "run-tests-glob-"));
  try {
    for (const rel of ["src/b.test.ts", "src/a.test.ts", "src/node_modules/x/c.test.ts", "src/other.ts"]) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), "");
    }

    assert.deepEqual(expandPatterns(["src/**/*.test.ts"], root), ["src/a.test.ts", "src/b.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
