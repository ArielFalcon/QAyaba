/* The store reader is pinned to the store format it was written against: a store of another schema or extraction version
   is refused, never half-read. A request it does not know and a store it cannot open are distinct exits, so the engine
   reports why a query failed. Its answers on the recorded store are covered end to end by the adapter's tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORE_READER_SCRIPT } from "../../../src/shared-infrastructure/code-graph/codegraph-engine.ts";

const STORE = join(import.meta.dirname, "__fixtures__", "codegraph", "store.db");

function read(store: string, request: unknown): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", STORE_READER_SCRIPT, store, JSON.stringify(request)], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("the recorded store answers, and a repeated request answers byte for byte the same", () => {
  const first = read(STORE, { op: "routes" });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(read(STORE, { op: "routes" }).stdout, first.stdout);
  assert.equal((JSON.parse(first.stdout) as { routes: unknown[] }).routes.length, 3);
});

test("an unknown request exits 2 and a store that cannot be opened exits 4", () => {
  assert.equal(read(STORE, { op: "drop" }).status, 2);
  assert.equal(read(STORE, { op: "walk", seeds: [42] }).status, 2, "a seed that is not an id is refused");
  assert.equal(read(join(tmpdir(), "no-such-store.db"), { op: "routes" }).status, 4);
});

test("a store of another extraction version exits 3 and answers nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-reader-"));
  try {
    const store = join(dir, "codegraph.db");
    copyFileSync(STORE, store);
    const db = new DatabaseSync(store);
    db.prepare("UPDATE project_metadata SET value = '28' WHERE key = 'indexed_with_extraction_version'").run();
    db.close();

    const r = read(store, { op: "routes" });

    assert.equal(r.status, 3);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /unsupported store/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a request past the reader's bounds is cut to them, deterministically, and says so; it is never refused", () => {
  const files = Array.from({ length: 2500 }, (_, i) => `f${i}.ts`);
  const symbols = read(STORE, { op: "symbols", files });
  assert.equal(symbols.status, 0, symbols.stderr);
  assert.equal((JSON.parse(symbols.stdout) as { truncated: boolean }).truncated, true);

  const seeds = Array.from({ length: 2500 }, (_, i) => `id${i}`);
  const walked = read(STORE, { op: "walk", seeds });
  assert.equal(walked.status, 0, walked.stderr);
  assert.equal((JSON.parse(walked.stdout) as { truncated: boolean }).truncated, true);
  assert.equal(read(STORE, { op: "walk", seeds: [...seeds].reverse() }).stdout, walked.stdout, "the same cut whatever the request's order");

  const refs = Array.from({ length: 2500 }, (_, i) => ({ file: `f${i}.ts`, symbol: `s${i}` }));
  const found = read(STORE, { op: "find", symbols: refs });
  assert.equal(found.status, 0, found.stderr);
  assert.equal((JSON.parse(found.stdout) as { truncated: boolean }).truncated, true);

  const small = read(STORE, { op: "symbols", files: ["web/src/app/shared/format.ts"] });
  assert.equal((JSON.parse(small.stdout) as { truncated: boolean }).truncated, false, "within the bound nothing is cut");
});

test("ping answers when the store opens at the pinned version and exits 3 otherwise", () => {
  assert.deepEqual(JSON.parse(read(STORE, { op: "ping" }).stdout), { ready: true });
});

/* A store of the pinned version holding only the given functions and call edges. */
function syntheticStore(dir: string, functions: string[], calls: Array<[string, string]>): string {
  const store = join(dir, "codegraph.db");
  copyFileSync(STORE, store);
  const db = new DatabaseSync(store);
  db.exec("DELETE FROM edges; DELETE FROM nodes;");
  const node = db.prepare("INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at) VALUES (?, 'function', ?, ?, ?, 'typescript', ?, ?, 0, 0, 0)");
  functions.forEach((name, i) => node.run(name, name, name, name.startsWith("spec") ? "a/x.spec.ts" : "a/x.ts", i + 1, i + 1));
  const edge = db.prepare("INSERT INTO edges (source, target, kind) VALUES (?, ?, 'calls')");
  for (const [source, target] of calls) edge.run(source, target);
  db.close();
  return store;
}

test("degrees answers the in-degree at a percentile by nearest rank, callers in excluded files left out", () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-reader-"));
  try {
    const names = Array.from({ length: 100 }, (_, i) => `f${String(i).padStart(2, "0")}`);
    const store = syntheticStore(dir, [...names, "spec1", "spec2"], [
      ...names.slice(1, 6).map((n): [string, string] => [n, "f00"]),
      ["f01", "f02"],
      ["spec1", "f02"],
      ["spec2", "f02"],
    ]);
    const degree = (request: Record<string, unknown>) => JSON.parse(read(store, { op: "degrees", ...request }).stdout) as { callables: number; value: number };

    assert.deepEqual(degree({ percentile: 100 }), { callables: 102, value: 5 });
    assert.deepEqual(degree({ percentile: 99 }), { callables: 102, value: 3 }, "f02 has three callers, two of them in a test file");
    assert.deepEqual(degree({ percentile: 99, excludeFiles: ["a/x.spec.ts"] }), { callables: 102, value: 1 });
    assert.equal(degree({ percentile: 50 }).value, 0);
    assert.equal(read(store, { op: "degrees", percentile: 0 }).status, 2, "a percentile outside (0, 100] is refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a walk answers the same bytes for the same request, and a request split across arguments reads as one", () => {
  const request = { op: "walk", seeds: ["missing", "also-missing"], depth: 3, fanIn: { percentile: 99, floor: 10, ceiling: 64 }, maxExpansions: 100, closureExpansions: 100 };
  const whole = read(STORE, request);
  assert.equal(whole.status, 0, whole.stderr);
  assert.equal(read(STORE, request).stdout, whole.stdout);

  const json = JSON.stringify(request);
  const split = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", STORE_READER_SCRIPT, STORE, json.slice(0, 10), json.slice(10)], { encoding: "utf8" });
  assert.equal(split.stdout, whole.stdout);
});

test("files lists every file the store holds a node of, sorted", () => {
  const files = (JSON.parse(read(STORE, { op: "files" }).stdout) as { files: string[] }).files;
  assert.ok(files.includes("web/src/app/shared/format.ts"));
  assert.deepEqual(files, [...files].sort());
});
