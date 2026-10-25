/* The store cache is what a run hands the next one, so it only ever holds a store the orchestrator read as a regular file
   of its own: never a link the sandbox planted, never a store whose write-ahead log is still beside it. Its lock keeps
   parallel lanes from racing, and a lock left by a dead process is broken. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodegraphStoreCache, repoKeyOf, type StoreMeta } from "../../../src/shared-infrastructure/code-graph/codegraph-store-cache.ts";

const META: StoreMeta = { engine: "codegraph", engineVersion: "1.6.2", sha: "a".repeat(40), nodeCount: 3, edgeCount: 2, fileCount: 1, builtAt: "2026-10-25T00:00:00.000Z" };

function setup() {
  const root = mkdtempSync(join(tmpdir(), "cg-cache-"));
  const workspace = join(root, "ws");
  mkdirSync(join(workspace, ".codegraph"), { recursive: true });
  return { root, workspace, cache: new CodegraphStoreCache(join(root, "cache")) };
}

test("a published store and its metadata come back, and copy into a fresh workspace", () => {
  const { root, workspace, cache } = setup();
  try {
    writeFileSync(join(workspace, ".codegraph", "codegraph.db"), "store-bytes");
    assert.deepEqual(cache.publish("org__app", workspace, META), { published: true });
    assert.deepEqual(cache.meta("org__app"), META);

    const next = join(root, "ws2");
    mkdirSync(join(next, ".codegraph"), { recursive: true });
    assert.equal(cache.copyIn("org__app", next, null), true);
    assert.equal(readFileSync(join(next, ".codegraph", "codegraph.db"), "utf8"), "store-bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nothing cached: no metadata and nothing to copy in", () => {
  const { root, workspace, cache } = setup();
  try {
    assert.equal(cache.meta("org__app"), undefined);
    assert.equal(cache.copyIn("org__app", workspace, null), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a store planted as a link is refused and the cache keeps nothing of it", () => {
  const { root, workspace, cache } = setup();
  try {
    const secret = join(root, "secret");
    writeFileSync(secret, "root-only secret");
    symlinkSync(secret, join(workspace, ".codegraph", "codegraph.db"));

    const result = cache.publish("org__app", workspace, META);

    assert.equal(result.published, false);
    assert.equal(cache.meta("org__app"), undefined);
    assert.equal(existsSync(join(root, "cache", "org__app", "codegraph.db")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a store whose write-ahead log is still beside it is refused", () => {
  const { root, workspace, cache } = setup();
  try {
    writeFileSync(join(workspace, ".codegraph", "codegraph.db"), "store-bytes");
    writeFileSync(join(workspace, ".codegraph", "codegraph.db-wal"), "pending");
    assert.deepEqual(cache.publish("org__app", workspace, META), { published: false, reason: "the store still has a write-ahead log" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("metadata that does not name the engine, its version and the commit reads as nothing cached", () => {
  const { root, workspace, cache } = setup();
  try {
    writeFileSync(join(workspace, ".codegraph", "codegraph.db"), "store-bytes");
    cache.publish("org__app", workspace, META);
    writeFileSync(join(root, "cache", "org__app", "meta.json"), JSON.stringify({ engine: "codegraph" }));
    assert.equal(cache.meta("org__app"), undefined);
    writeFileSync(join(root, "cache", "org__app", "meta.json"), "not json");
    assert.equal(cache.meta("org__app"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the lock is exclusive until released, and a lock older than its stale age is broken", () => {
  const { root } = setup();
  const now = Date.now();
  const cache = new CodegraphStoreCache(join(root, "cache"), () => now);
  try {
    const first = cache.lock("org__app");
    assert.ok(first);
    assert.equal(cache.lock("org__app"), undefined, "a second lane waits its turn");
    first.release();
    const second = cache.lock("org__app");
    assert.ok(second, "a released lock can be taken again");

    const lockFile = join(root, "cache", "org__app", "lock");
    const old = new Date(now - 16 * 60_000);
    utimesSync(lockFile, old, old);
    assert.ok(cache.lock("org__app"), "a lock left by a dead process is broken");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repo key is a single file name whatever the mirror is called", () => {
  assert.equal(repoKeyOf("org__app"), "org__app");
  assert.equal(repoKeyOf("../../etc"), "__.._etc", "no separator and no leading dot survive");
  assert.equal(repoKeyOf(""), "_");
  assert.equal(repoKeyOf("a/b c"), "a_b_c");
});
