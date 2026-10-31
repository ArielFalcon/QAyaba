/* The seed's coverage fixture writes each script a worker's pages ran once, as `<sha256>.script.json`, and a test's dump names the script by that sha256 instead of carrying its source and map, so a test pays only for the scripts its worker has not seen. Its teardown has a time of its own. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const SEED = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", "config", "e2e", "fixtures.ts"), "utf8");

/* The `_coverage` fixture's declaration: its function and its options, as the seed writes them. */
function coverageFixture(): { body: string; options: string } {
  const file = ts.createSourceFile("fixtures.ts", SEED, ts.ScriptTarget.ES2022, true);
  let found: ts.ArrayLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === "_coverage" && ts.isArrayLiteralExpression(node.initializer)) found = node.initializer;
    else ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(found, "the seed declares a _coverage fixture");
  return { body: found.elements[0]!.getText(file), options: found.elements[1]!.getText(file) };
}

type Fixture = (args: { page: unknown }, use: () => Promise<void>, testInfo: unknown) => Promise<void>;

/* The fixture, compiled with what it uses from its module, as one worker loads it; the source maps are attached by a stand-in that records which scripts it was asked for, and finds none when `maps` is false (a map fetch that failed). */
function loadFixture(mapped: string[], maps = true): Fixture {
  const js = ts.transpileModule(`const fixture = ${coverageFixture().body};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const attachSourceMaps = async (entries: Array<{ url?: string; map?: unknown }>) => {
    for (const entry of entries) {
      mapped.push(entry.url ?? "");
      if (maps) entry.map = { version: 3, sources: ["src/app.ts"], mappings: "AAAA" };
    }
  };
  const deps = { createHash, linkSync, mkdirSync, renameSync, rmSync, writeFileSync, join, attachSourceMaps, coverageScriptsWritten: new Map<string, Set<string>>() };
  return new Function(...Object.keys(deps), `${js}\nreturn fixture;`)(...Object.values(deps)) as Fixture;
}

const APP = { url: "https://dev.example/main.js", source: "function a(){return 1}", functions: [{ functionName: "a", ranges: [{ startOffset: 0, endOffset: 22, count: 1 }] }] };
const VENDOR = { url: "https://dev.example/vendor.js", source: "function v(){}", functions: [{ functionName: "v", ranges: [{ startOffset: 0, endOffset: 14, count: 1 }] }] };
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

async function runTests(titles: string[][], scripts: (typeof APP)[]): Promise<{ dir: string; mapped: string[]; cleanup: () => void }> {
  const cwd = mkdtempSync(join(tmpdir(), "seed-coverage-"));
  const keys = ["PW_COVERAGE", "PW_NAMESPACE", "PW_CLEANUP"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const savedCwd = process.cwd();
  process.env.PW_COVERAGE = "1";
  process.env.PW_NAMESPACE = "run-1-measure";
  delete process.env.PW_CLEANUP;
  process.chdir(cwd);
  const mapped: string[] = [];
  try {
    const fixture = loadFixture(mapped);
    for (const titlePath of titles) {
      const page = { coverage: { startJSCoverage: async () => {}, stopJSCoverage: async () => scripts.map((s) => structuredClone(s)) }, request: {} };
      await fixture({ page }, async () => {}, { titlePath, workerIndex: 0, repeatEachIndex: 0 });
    }
  } finally {
    process.chdir(savedCwd);
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  return { dir: join(cwd, ".qa", "coverage", "run-1-measure"), mapped, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("each script is written once per worker, whole, and a dump names it by its sha256", async () => {
  const run = await runTests([["map.spec.ts", "opens the map"], ["list.spec.ts", "lists the shops"]], [APP, VENDOR]);
  try {
    const files = readdirSync(run.dir).sort();
    assert.deepEqual(files.filter((f) => f.endsWith(".script.json")).sort(), [`${sha(APP.source)}.script.json`, `${sha(VENDOR.source)}.script.json`].sort());
    assert.equal(files.filter((f) => f.endsWith(".tmp")).length, 0, "no temporary file is left");
    const [script] = JSON.parse(readFileSync(join(run.dir, `${sha(APP.source)}.script.json`), "utf8")) as Array<Record<string, unknown>>;
    assert.equal(script!.sha256, sha(APP.source));
    assert.equal(script!.source, APP.source);
    assert.equal(script!.url, APP.url);
    assert.ok(script!.map, "the script's map is kept with it");
    const dumps = files.filter((f) => !f.endsWith(".script.json"));
    assert.equal(dumps.length, 2);
    for (const name of dumps) {
      const entries = JSON.parse(readFileSync(join(run.dir, name), "utf8")) as Array<Record<string, unknown>>;
      assert.deepEqual(entries.map((e) => e.sha256).sort(), [sha(APP.source), sha(VENDOR.source)].sort());
      for (const entry of entries) {
        assert.equal(entry.source, undefined);
        assert.equal(entry.map, undefined);
        assert.ok(Array.isArray(entry.functions));
      }
    }
  } finally {
    run.cleanup();
  }
});

test("a script the worker already wrote is not mapped again", async () => {
  const run = await runTests([["map.spec.ts", "opens the map"], ["list.spec.ts", "lists the shops"]], [APP]);
  try {
    assert.deepEqual(run.mapped, [APP.url]);
  } finally {
    run.cleanup();
  }
});

test("the coverage teardown has a time of its own", () => {
  assert.match(coverageFixture().options, /timeout:\s*\d/);
});

/* Two workers of one execution, each writing the scripts its pages ran: `first` writes, then `second`; each is mapped or not. */
async function twoWorkers(first: "mapped" | "unmapped", second: "mapped" | "unmapped"): Promise<{ map: unknown; cleanup: () => void }> {
  const cwd = mkdtempSync(join(tmpdir(), "seed-coverage-workers-"));
  const keys = ["PW_COVERAGE", "PW_NAMESPACE", "PW_CLEANUP"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const savedCwd = process.cwd();
  process.env.PW_COVERAGE = "1";
  process.env.PW_NAMESPACE = "run-1-measure";
  delete process.env.PW_CLEANUP;
  process.chdir(cwd);
  try {
    for (const [index, kind] of [first, second].entries()) {
      const fixture = loadFixture([], kind === "mapped");
      const page = { coverage: { startJSCoverage: async () => {}, stopJSCoverage: async () => [structuredClone(APP)] }, request: {} };
      await fixture({ page }, async () => {}, { titlePath: ["map.spec.ts", `test ${index}`], workerIndex: index, repeatEachIndex: 0 });
    }
  } finally {
    process.chdir(savedCwd);
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  const dir = join(cwd, ".qa", "coverage", "run-1-measure");
  const [script] = JSON.parse(readFileSync(join(dir, `${sha(APP.source)}.script.json`), "utf8")) as Array<{ map?: unknown }>;
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0, "no temporary file is left");
  return { map: script!.map, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("a worker whose map fetch failed never replaces the script another worker wrote with its map", async () => {
  const run = await twoWorkers("mapped", "unmapped");
  try {
    assert.ok(run.map, "the mapped copy stands");
  } finally {
    run.cleanup();
  }
});

test("a mapped copy replaces an unmapped one another worker wrote first", async () => {
  const run = await twoWorkers("unmapped", "mapped");
  try {
    assert.ok(run.map);
  } finally {
    run.cleanup();
  }
});

test("a script no worker could map is still written, once", async () => {
  const run = await twoWorkers("unmapped", "unmapped");
  try {
    assert.equal(run.map, undefined);
  } finally {
    run.cleanup();
  }
});
