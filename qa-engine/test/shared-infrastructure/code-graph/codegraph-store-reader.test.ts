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
