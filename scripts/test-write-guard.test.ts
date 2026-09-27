/* The suite's preload (test-setup.mjs) forbids writes into the repository's tracked tree: node --test
   runs test files in parallel, so a file planted under src/ or qa-engine/src/ — even one removed in a
   finally — is visible to every concurrent test that scans the tree, and a crashed run leaves it
   behind to be committed. These tests run under that same preload. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
const refusal = (e: unknown): boolean => (e as { code?: string }).code === "ERR_TEST_TRACKED_TREE_WRITE";

/* If the guard is missing the write lands in the real tree — remove it so a failing run leaves nothing behind. */
function removeIfPresent(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

test("a test cannot write a file under src/, qa-engine/src/ or config/", () => {
  const probes = [
    join(repoRoot, "src", `.write-guard-probe-${process.pid}.ts`),
    join(repoRoot, "qa-engine", "src", `.write-guard-probe-${process.pid}.ts`),
    join(repoRoot, "config", `.write-guard-probe-${process.pid}.yaml`),
  ];
  try {
    for (const probe of probes) {
      assert.throws(() => writeFileSync(probe, "export {};\n"), refusal, `writing ${probe} must be refused`);
      assert.equal(existsSync(probe), false, `${probe} must not exist after a refused write`);
    }
  } finally {
    for (const probe of probes) removeIfPresent(probe);
  }
});

test("a test cannot create a directory or open a write stream inside the tracked tree", () => {
  const dir = join(repoRoot, "qa-engine", "src", `.write-guard-dir-${process.pid}`);
  const streamTarget = join(repoRoot, "src", `.write-guard-stream-${process.pid}.log`);
  try {
    assert.throws(() => mkdirSync(dir, { recursive: true }), refusal);
    assert.throws(() => createWriteStream(streamTarget), refusal);
    assert.equal(existsSync(dir), false);
    assert.equal(existsSync(streamTarget), false);
  } finally {
    removeIfPresent(dir);
    removeIfPresent(streamTarget);
  }
});

test("an async write into the tracked tree rejects instead of landing", async () => {
  const probe = join(repoRoot, "src", `.write-guard-async-${process.pid}.ts`);
  try {
    await assert.rejects(() => writeFile(probe, "export {};\n"), refusal);
    assert.equal(existsSync(probe), false);
  } finally {
    removeIfPresent(probe);
  }
});

test("writes under the OS temp directory are unaffected", () => {
  const dir = mkdtempSync(join(tmpdir(), "write-guard-"));
  try {
    const file = join(dir, "nested", "file.txt");
    mkdirSync(join(dir, "nested"));
    writeFileSync(file, "ok");
    assert.equal(readFileSync(file, "utf8"), "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
