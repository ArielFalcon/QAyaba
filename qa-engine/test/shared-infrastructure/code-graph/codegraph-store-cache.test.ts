/* The store cache is what a run hands the next one, so it only ever holds a store the orchestrator read as a regular file
   of its own: never a link the sandbox planted, never a store whose write-ahead log is still beside it. Its lock keeps
   parallel lanes from racing, and a lock left by a dead process is broken. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodegraphStoreCache, repoKeyOf, type StoreMeta } from "../../../src/shared-infrastructure/code-graph/codegraph-store-cache.ts";

const META: StoreMeta = { engine: "codegraph", engineVersion: "1.6.2", scope: "0123456789abcdef", sha: "a".repeat(40), nodeCount: 3, edgeCount: 2, fileCount: 1, builtAt: "2026-10-25T00:00:00.000Z" };

function setup() {
  const root = mkdtempSync(join(tmpdir(), "cg-cache-"));
  const workspace = join(root, "ws");
  mkdirSync(join(workspace, ".codegraph"), { recursive: true });
  return { root, workspace, cache: new CodegraphStoreCache(join(root, "cache")) };
}

const identityOf = (dir: string) => {
  const st = lstatSync(dir);
  return { dev: st.dev, ino: st.ino };
};

test("a published store and its metadata come back, and copy into a fresh workspace", () => {
  const { root, workspace, cache } = setup();
  try {
    writeFileSync(join(workspace, ".codegraph", "codegraph.db"), "store-bytes");
    assert.deepEqual(cache.publish("org__app", workspace, identityOf(workspace), META), { published: true });
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

    const result = cache.publish("org__app", workspace, identityOf(workspace), META);

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
    assert.deepEqual(cache.publish("org__app", workspace, identityOf(workspace), META), { published: false, reason: "the store still has a write-ahead log" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("metadata that does not name the engine, its version and the commit reads as nothing cached", () => {
  const { root, workspace, cache } = setup();
  try {
    writeFileSync(join(workspace, ".codegraph", "codegraph.db"), "store-bytes");
    cache.publish("org__app", workspace, identityOf(workspace), META);
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

test("a workspace swapped for a link or another directory after the export is refused", () => {
  const { root, workspace, cache } = setup();
  try {
    writeFileSync(join(workspace, ".codegraph", "codegraph.db"), "store-bytes");
    const identity = identityOf(workspace);

    const planted = join(root, "planted");
    mkdirSync(join(planted, ".codegraph"), { recursive: true });
    writeFileSync(join(planted, ".codegraph", "codegraph.db"), "planted-bytes");
    renameSync(workspace, join(root, "moved"));
    symlinkSync(planted, workspace);
    assert.deepEqual(cache.publish("org__app", workspace, identity, META), { published: false, reason: "the workspace was replaced" });

    unlinkSync(workspace);
    renameSync(planted, workspace);
    assert.deepEqual(cache.publish("org__app", workspace, identity, META), { published: false, reason: "the workspace was replaced" });
    assert.equal(cache.meta("org__app"), undefined);
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

test("a crash between the two renames of a publish never leaves one commit's store under another commit's cursor", () => {
  const { root, workspace, cache } = setup();
  try {
    writeFileSync(join(workspace, ".codegraph", "codegraph.db"), "store-a");
    cache.publish("org__app", workspace, identityOf(workspace), META);

    writeFileSync(join(workspace, ".codegraph", "codegraph.db"), "store-b");
    let renames = 0;
    const crashing = new CodegraphStoreCache(join(root, "cache"), Date.now, {
      rename: (from, to) => {
        if (++renames === 2) throw new Error("killed between the renames");
        renameSync(from, to);
      },
    });
    const result = crashing.publish("org__app", workspace, identityOf(workspace), { ...META, sha: "b".repeat(40) });

    assert.equal(result.published, false);
    assert.equal(cache.meta("org__app"), undefined, "no cursor claims the store that was swapped in");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a store is copied in pieces whatever its size relative to a piece, and one past the cap is refused", () => {
  const { root, workspace } = setup();
  try {
    const bytes = "0123456789abcdef-the-store";
    writeFileSync(join(workspace, ".codegraph", "codegraph.db"), bytes);
    const small = new CodegraphStoreCache(join(root, "cache"), Date.now, { chunkBytes: 4 });
    assert.deepEqual(small.publish("org__app", workspace, identityOf(workspace), META), { published: true });
    assert.equal(readFileSync(join(root, "cache", "org__app", "codegraph.db"), "utf8"), bytes);

    const capped = new CodegraphStoreCache(join(root, "cache2"), Date.now, { maxStoreBytes: bytes.length - 1 });
    const refused = capped.publish("org__app", workspace, identityOf(workspace), META);
    assert.equal(refused.published, false);
    assert.equal(capped.meta("org__app"), undefined);
    assert.equal(existsSync(join(root, "cache2", "org__app", "codegraph.db")), false);
    assert.deepEqual(readdirSync(join(root, "cache2", "org__app")), [], "no temporary file is left");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a named pipe planted as the store is refused without being waited on", () => {
  const { root, workspace, cache } = setup();
  try {
    execFileSync("mkfifo", [join(workspace, ".codegraph", "codegraph.db")]);
    const result = cache.publish("org__app", workspace, identityOf(workspace), META);
    assert.equal(result.published, false);
    assert.equal(cache.meta("org__app"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two takers of a stale lock never both hold it: the one that finds the lock replaced backs off", () => {
  const { root } = setup();
  const now = Date.now();
  const winner = new CodegraphStoreCache(join(root, "cache"), () => now);
  let winnerLock: ReturnType<CodegraphStoreCache["lock"]>;
  const loser = new CodegraphStoreCache(join(root, "cache"), () => now, {
    /* The instant after the loser judged the lock stale and before it acts: the other taker completes its takeover. */
    beforeTakeover: () => {
      winnerLock = winner.lock("org__app");
    },
  });
  try {
    const first = winner.lock("org__app");
    assert.ok(first);
    const lockFile = join(root, "cache", "org__app", "lock");
    const old = new Date(now - 16 * 60_000);
    utimesSync(lockFile, old, old);

    const taken = loser.lock("org__app");

    assert.ok(winnerLock!, "the other taker holds the lock");
    assert.equal(taken, undefined, "the loser did not break the fresh lock");
    assert.equal(existsSync(lockFile), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a holder that outlived its lock does not release the lock of whoever took over", () => {
  const { root } = setup();
  const now = Date.now();
  const cache = new CodegraphStoreCache(join(root, "cache"), () => now);
  try {
    const slow = cache.lock("org__app");
    assert.ok(slow);
    const lockFile = join(root, "cache", "org__app", "lock");
    const old = new Date(now - 16 * 60_000);
    utimesSync(lockFile, old, old);
    const taker = cache.lock("org__app");
    assert.ok(taker);

    slow.release();

    assert.equal(existsSync(lockFile), true, "the new holder's lock stands");
    assert.equal(cache.lock("org__app"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a discarded store is gone, with its metadata", () => {
  const { root, workspace, cache } = setup();
  try {
    writeFileSync(join(workspace, ".codegraph", "codegraph.db"), "store-bytes");
    cache.publish("org__app", workspace, identityOf(workspace), META);
    cache.discard("org__app");
    assert.equal(cache.meta("org__app"), undefined);
    assert.equal(cache.copyIn("org__app", workspace, null), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
