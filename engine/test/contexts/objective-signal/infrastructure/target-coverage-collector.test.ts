/* test/contexts/objective-signal/infrastructure/target-coverage-collector.test.ts
   Behavioral tests for makeTargetCoverageCollector — the real, src/-free CoverageCollectorPort
   factory over the V8 browser dumps (real readV8Dumps).
   Uses REAL temp-dir fixtures end to end (no per-function mocking) — this proves the whole wiring,
   not just the reader in isolation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTargetCoverageCollector } from "@contexts/objective-signal/infrastructure/target-coverage-collector.ts";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "engine-target-coverage-collector-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("collects from real V8 dumps under .qa/coverage/<namespace>", async () => {
  await withTmpDir(async (e2eDir) => {
    const dumpDir = join(e2eDir, ".qa", "coverage", "qa-abc");
    mkdirSync(dumpDir, { recursive: true });
    const entries = [
      {
        url: "https://dev/src/svc.ts",
        source: "export function f() {\n  return 1;\n}\n",
        functions: [{ ranges: [{ startOffset: 0, endOffset: 34, count: 3 }] }],
      },
    ];
    writeFileSync(join(dumpDir, "dump.json"), JSON.stringify(entries));

    const collector = makeTargetCoverageCollector(["src/svc.ts"]);
    const report = await collector.collect(e2eDir, "qa-abc");
    const file = report.covered.find((c) => c.file === "src/svc.ts");
    assert.ok(file, "V8 dump must resolve to the changed file via URL suffix match");
    assert.ok(file!.lines.includes(1));
  });
});

test("a bundle's dumps are read through its source map, and what each dump covers adds up", async () => {
  await withTmpDir(async (e2eDir) => {
    const dumpDir = join(e2eDir, ".qa", "coverage", "qa-abc");
    mkdirSync(dumpDir, { recursive: true });
    /* Line 1 of the bundle is from src/a.ts line 1, and line 2 from src/a.ts line 2. */
    const map = { version: 3, sources: ["../src/a.ts"], mappings: "AAAA;AACA" };
    const dump = (from: number, to: number): string =>
      JSON.stringify([{ url: "https://dev/assets/main.js", source: "a();\nb();\n", functions: [{ ranges: [{ startOffset: from, endOffset: to, count: 1 }] }], map }]);
    writeFileSync(join(dumpDir, "t1.json"), dump(0, 5));
    writeFileSync(join(dumpDir, "t2.json"), dump(5, 10));

    const collector = makeTargetCoverageCollector(["src/a.ts"]);
    const report = await collector.collect(e2eDir, "qa-abc");

    assert.deepEqual(report.covered.map((c) => [c.file, [...c.lines].sort()]), [["src/a.ts", [1, 2]]], "the first test ran line 1 and the second line 2");
  });
});

test("no dumps -> empty report (never blocks, unknown)", async () => {
  await withTmpDir(async (e2eDir) => {
    const collector = makeTargetCoverageCollector(["src/svc.ts"]);
    const report = await collector.collect(e2eDir, "qa-none");
    assert.deepEqual(report.covered, []);
  });
});
