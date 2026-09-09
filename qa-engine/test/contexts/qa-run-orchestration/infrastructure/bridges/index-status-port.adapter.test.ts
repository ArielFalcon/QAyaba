// IndexStatusAdapter — durable lastIndexedSha keyed by mirrorDir (fail-open JSON sidecar).
// SHA skip (same SHA → do not reindex) is a RunQaUseCase concern, not this adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexStatusAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/index-status-port.adapter.ts";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "index-status-"));
}

test("IndexStatusAdapter: missing file → getLastIndexedSha returns undefined", async () => {
  const dataDir = tmpDataDir();
  try {
    const adapter = new IndexStatusAdapter(dataDir);
    const sha = await adapter.getLastIndexedSha("/mirrors/org/app");
    assert.equal(sha, undefined);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("IndexStatusAdapter: set then get roundtrip isolates two different mirrorDirs", async () => {
  const dataDir = tmpDataDir();
  try {
    const adapter = new IndexStatusAdapter(dataDir);
    await adapter.setLastIndexedSha("/mirrors/org/app-a", "abc1234");
    await adapter.setLastIndexedSha("/mirrors/org/app-b", "def5678");

    assert.equal(await adapter.getLastIndexedSha("/mirrors/org/app-a"), "abc1234");
    assert.equal(await adapter.getLastIndexedSha("/mirrors/org/app-b"), "def5678");
    assert.equal(await adapter.getLastIndexedSha("/mirrors/org/unknown"), undefined);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("IndexStatusAdapter: corrupt JSON → undefined, then set recovers", async () => {
  const dataDir = tmpDataDir();
  try {
    writeFileSync(join(dataDir, "index-status.json"), "{not-json", "utf8");
    const adapter = new IndexStatusAdapter(dataDir);

    assert.equal(await adapter.getLastIndexedSha("/mirrors/org/app"), undefined);

    await adapter.setLastIndexedSha("/mirrors/org/app", "abc1234");
    assert.equal(await adapter.getLastIndexedSha("/mirrors/org/app"), "abc1234");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("IndexStatusAdapter: JSON array → getLastIndexedSha returns undefined", async () => {
  const dataDir = tmpDataDir();
  try {
    writeFileSync(join(dataDir, "index-status.json"), '["abc1234"]', "utf8");
    const adapter = new IndexStatusAdapter(dataDir);
    assert.equal(await adapter.getLastIndexedSha("/mirrors/org/app"), undefined);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("IndexStatusAdapter: JSON primitive → getLastIndexedSha returns undefined", async () => {
  const dataDir = tmpDataDir();
  try {
    writeFileSync(join(dataDir, "index-status.json"), '"abc1234"', "utf8");
    const adapter = new IndexStatusAdapter(dataDir);
    assert.equal(await adapter.getLastIndexedSha("/mirrors/org/app"), undefined);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
