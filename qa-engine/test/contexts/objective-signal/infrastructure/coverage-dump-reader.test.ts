/* test/contexts/objective-signal/infrastructure/coverage-dump-reader.test.ts
   missing `(specDir, namespace) => Promise<T[]>` closures the existing collector adapters declare
   but never got a real default for — see F.2's GAP note (engram obs #914). Each reader is exercised
   against a real temp-dir fixture (no FS mocking — the readers ARE the FS boundary), asserting the
   exact injected-type shape each adapter expects (the covered lines of each dump / CoverageFile[] /
   IstanbulFile[] / JacocoFile[]) and the fail-open contract (absent dir/files -> empty array, never throw).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_V8_DUMPS_TOTAL_BYTES, V8_DUMP_LIMITS, readV8Coverage, readNativeReports } from "@contexts/objective-signal/infrastructure/coverage-dump-reader.ts";

async function withTmpDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "qa-engine-coverage-dump-reader-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── readV8Coverage: e2eDir + namespace -> V8_DUMP_DIR = join(e2eDir, ".qa", "coverage", namespace); each dump is reduced to the lines of the changed files it covers as it is read ── */

/* "export function f() {\n" is bytes 0..21 (line 1), "  return 1;\n" is 22..33 (line 2), "}\n" is 34..35 (line 3). */
const SOURCE = "export function f() {\n  return 1;\n}\n";
const dumpOf = (...ranges: Array<[number, number]>): string =>
  JSON.stringify([{ url: "https://dev/src/svc.ts", source: SOURCE, functions: [{ ranges: ranges.map(([startOffset, endOffset]) => ({ startOffset, endOffset, count: 1 })) }] }]);

test("readV8Coverage: reads every *.json dump under .qa/coverage/<namespace> and reduces each to the lines of the changed files it covers, in the order of the names", async () => {
  await withTmpDir(async (e2eDir) => {
    const dumpDir = join(e2eDir, ".qa", "coverage", "qa-abc");
    mkdirSync(dumpDir, { recursive: true });
    writeFileSync(join(dumpDir, "a.json"), dumpOf([0, 22]));
    writeFileSync(join(dumpDir, "b.json"), dumpOf([22, 34], [34, 36]));
    writeFileSync(join(dumpDir, "c.json"), JSON.stringify([]));
    writeFileSync(join(dumpDir, "not-a-dump.txt"), "ignore me");

    const dumps = await readV8Coverage(e2eDir, "qa-abc", ["src/svc.ts"]);

    assert.deepEqual(dumps.map((d) => [...(d.get("src/svc.ts") ?? [])].sort()), [[1], [2, 3], []], "only .json files are read, one result for each, and what a dump covers of the changed file is all that is kept");
  });
});

test("readV8Coverage: what comes back is the lines the parse reduced each dump to and nothing of the dump, which the parse is given whole with the changed files", async () => {
  await withTmpDir(async (e2eDir) => {
    const dumpDir = join(e2eDir, ".qa", "coverage", "qa-abc");
    mkdirSync(dumpDir, { recursive: true });
    const entries = [{ url: "https://dev/src/svc.ts", source: "x", functions: [] }];
    writeFileSync(join(dumpDir, "a.json"), JSON.stringify(entries));
    writeFileSync(join(dumpDir, "b.json"), JSON.stringify({ not: "an array" }));
    const given: unknown[] = [];

    const dumps = await readV8Coverage(e2eDir, "qa-abc", ["src/x.ts"], undefined, (parsed, changed) => {
      given.push([parsed, changed]);
      return new Map([["marker", new Set([given.length])]]);
    });

    assert.deepEqual(given, [[entries, ["src/x.ts"]], [[], ["src/x.ts"]]], "a dump that is no list of entries is a list of none");
    assert.deepEqual(dumps, [new Map([["marker", new Set([1])]]), new Map([["marker", new Set([2])]])]);
  });
});

test("readV8Coverage: returns [] when the namespace directory does not exist (fail-open)", async () => {
  await withTmpDir(async (e2eDir) => {
    const dumps = await readV8Coverage(e2eDir, "qa-does-not-exist", ["src/svc.ts"]);
    assert.deepEqual(dumps, []);
  });
});

test("readV8Coverage: a corrupt (non-JSON) dump file leaves the set unused instead of throwing: the dumps beside it are a part of the whole", async () => {
  await withTmpDir(async (e2eDir) => {
    const dumpDir = join(e2eDir, ".qa", "coverage", "qa-abc");
    mkdirSync(dumpDir, { recursive: true });
    writeFileSync(join(dumpDir, "corrupt.json"), "{not valid json");
    writeFileSync(join(dumpDir, "good.json"), dumpOf([0, 22]));

    const dumps = await readV8Coverage(e2eDir, "qa-abc", ["src/svc.ts"]);
    assert.deepEqual(dumps, [], "nothing is thrown, and nothing is measured from the rest");
  });
});

test("readV8Coverage: a dump the parse cannot decode within its bounds leaves the set unused, as a dump that is no JSON does", async () => {
  await withTmpDir(async (e2eDir) => {
    const dumpDir = join(e2eDir, ".qa", "coverage", "qa-abc");
    mkdirSync(dumpDir, { recursive: true });
    writeFileSync(join(dumpDir, "good.json"), dumpOf([0, 22]));
    writeFileSync(join(dumpDir, "hostile.json"), JSON.stringify([{ url: "https://dev/src/svc.ts", source: SOURCE, functions: 5 }]));

    const dumps = await readV8Coverage(e2eDir, "qa-abc", ["src/svc.ts"]);
    assert.deepEqual(dumps, [], "the good dump is not used beside it");
  });
});

/* Measured with esbuild bundles and V8's own precise coverage: a dump of a 3.4 MiB bundle (typescript, minified) with its source map and ranges is 19 MiB, and one of a 0.6 MiB bundle 3 MiB. Decoding ran at about 100 MiB a second. */
test("the production limits hold a suite of fifty dumps of the largest size measured and one dump of half as much again, and are no more than a minute of decoding", () => {
  const largestMeasured = 19 * 1024 * 1024;

  assert.ok(V8_DUMP_LIMITS.maxTotalBytes >= 50 * largestMeasured, "the budget holds fifty of them");
  assert.ok(V8_DUMP_LIMITS.maxFileBytes >= 1.5 * largestMeasured, "a dump holds half as much again as the largest");
  assert.ok(V8_DUMP_LIMITS.maxTotalBytes <= 100 * 1024 * 1024 * 60, "and is a minute at 100 MiB a second");
  assert.equal(V8_DUMP_LIMITS.maxTotalBytes, MAX_V8_DUMPS_TOTAL_BYTES);
});

test("readV8Coverage: a non-array JSON dump covers nothing (fail-open)", async () => {
  await withTmpDir(async (e2eDir) => {
    const dumpDir = join(e2eDir, ".qa", "coverage", "qa-abc");
    mkdirSync(dumpDir, { recursive: true });
    writeFileSync(join(dumpDir, "object.json"), JSON.stringify({ not: "an array" }));

    const dumps = await readV8Coverage(e2eDir, "qa-abc", ["src/svc.ts"]);
    assert.equal(dumps.length, 1);
    assert.equal(dumps[0]!.size, 0);
  });
});

/* ── lcov: repoDir + conventional relative paths (no namespace — native reports are per-run-directory ──
   ── scoped by the tool itself, not by our namespace convention) ──────────────────────────────────────
 */

test("readNativeReports lcov: reads coverage/lcov.info when present", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "coverage"), { recursive: true });
    const lcov = "SF:src/a.ts\nDA:1,2\nend_of_record\n";
    writeFileSync(join(repoDir, "coverage", "lcov.info"), lcov);

    const { lcov: files } = await readNativeReports(repoDir);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.text, lcov);
  });
});

test("readNativeReports lcov: falls back to lcov.info at repo root when coverage/lcov.info is absent", async () => {
  await withTmpDir(async (repoDir) => {
    const lcov = "SF:src/b.ts\nDA:5,1\nend_of_record\n";
    writeFileSync(join(repoDir, "lcov.info"), lcov);

    const { lcov: files } = await readNativeReports(repoDir);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.text, lcov);
  });
});

test("readNativeReports lcov: falls back to coverage/lcov/lcov.info as the third conventional path", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "coverage", "lcov"), { recursive: true });
    const lcov = "SF:src/c.ts\nDA:9,4\nend_of_record\n";
    writeFileSync(join(repoDir, "coverage", "lcov", "lcov.info"), lcov);

    const { lcov: files } = await readNativeReports(repoDir);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.text, lcov);
  });
});

test("readNativeReports lcov: returns [] when no conventional lcov path exists (fail-open)", async () => {
  await withTmpDir(async (repoDir) => {
    const { lcov: files } = await readNativeReports(repoDir);
    assert.deepEqual(files, []);
  });
});

/* ── istanbul: repoDir/coverage/coverage-final.json ─────────────────────────────────── */

test("readNativeReports istanbul: reads coverage/coverage-final.json when present", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "coverage"), { recursive: true });
    const json = { "/repo/src/a.ts": { path: "/repo/src/a.ts", statementMap: {}, s: {} } };
    writeFileSync(join(repoDir, "coverage", "coverage-final.json"), JSON.stringify(json));

    const { istanbul: files } = await readNativeReports(repoDir);
    assert.equal(files.length, 1);
    assert.deepEqual(files[0]!.json, json);
  });
});

test("readNativeReports istanbul: returns [] when coverage-final.json is absent (fail-open)", async () => {
  await withTmpDir(async (repoDir) => {
    const { istanbul: files } = await readNativeReports(repoDir);
    assert.deepEqual(files, []);
  });
});

test("readNativeReports istanbul: a corrupt coverage-final.json degrades to [] instead of throwing", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "coverage"), { recursive: true });
    writeFileSync(join(repoDir, "coverage", "coverage-final.json"), "{not valid json");

    const { istanbul: files } = await readNativeReports(repoDir);
    assert.deepEqual(files, []);
  });
});

/* ── jacoco: Maven/Gradle conventional JaCoCo XML report paths ───────────────────────── */

test("readNativeReports jacoco: reads the Maven default report path", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "target", "site", "jacoco"), { recursive: true });
    const xml = "<report></report>";
    writeFileSync(join(repoDir, "target", "site", "jacoco", "jacoco.xml"), xml);

    const { jacoco: files } = await readNativeReports(repoDir);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.text, xml);
  });
});

test("readNativeReports jacoco: reads the Gradle default report path", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "build", "reports", "jacoco", "test"), { recursive: true });
    const xml = "<report gradle=\"true\"></report>";
    writeFileSync(join(repoDir, "build", "reports", "jacoco", "test", "jacocoTestReport.xml"), xml);

    const { jacoco: files } = await readNativeReports(repoDir);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.text, xml);
  });
});

test("readNativeReports jacoco: falls back to target/jacoco.xml as the third conventional path", async () => {
  await withTmpDir(async (repoDir) => {
    mkdirSync(join(repoDir, "target"), { recursive: true });
    const xml = "<report fallback=\"true\"></report>";
    writeFileSync(join(repoDir, "target", "jacoco.xml"), xml);

    const { jacoco: files } = await readNativeReports(repoDir);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.text, xml);
  });
});

test("readNativeReports jacoco: returns [] when no conventional JaCoCo path exists (fail-open)", async () => {
  await withTmpDir(async (repoDir) => {
    const { jacoco: files } = await readNativeReports(repoDir);
    assert.deepEqual(files, []);
  });
});
