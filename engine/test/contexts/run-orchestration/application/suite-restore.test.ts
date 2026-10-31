/* The suite restore port over a real working copy: a snapshot reads the pre-turn bytes of every spec through the confined
 * reader (a link or a climb out is refused, and a faithful "before" must not stand in for the proven bytes); a restore writes
 * those bytes back and removes the files the turn created, so the bytes on disk always equal the last bytes that executed green. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suiteRestorePort } from "@contexts/run-orchestration/application/suite-restore.ts";
import { MAX_SPEC_SOURCE_BYTES } from "../../../../src/shared-kernel/ports/spec-files.port.ts";
import { confinedSpecFiles } from "../../../../src/shared-infrastructure/spec-files.adapter.ts";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const textOf = (bytes: Uint8Array | undefined): string => (bytes === undefined ? "" : Buffer.from(bytes).toString("utf8"));

function withRoot<T>(run: (root: { mirrorDir: string; specDir: string }) => T | Promise<T>): Promise<T> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-spec-snapshot-"));
  const mirrorDir = join(tmp, "mirror");
  const specDir = join(mirrorDir, "e2e");
  mkdirSync(specDir, { recursive: true });
  return Promise.resolve(run({ mirrorDir, specDir })).finally(() => rmSync(tmp, { recursive: true, force: true }));
}

test("a snapshot reads the bytes of each spec through the confined reader, and a restore puts them back exactly", async () => {
  await withRoot(async (root) => {
    mkdirSync(join(root.specDir, "flows"), { recursive: true });
    writeFileSync(join(root.specDir, "flows", "a.spec.ts"), "the green bytes");
    writeFileSync(join(root.specDir, "flows", "b.spec.ts"), "b green");
    const port = suiteRestorePort(root, confinedSpecFiles);

    const snapshot = await port.snapshot(root.specDir, ["flows/a.spec.ts", "flows/b.spec.ts"]);
    assert.equal(textOf(snapshot.files.get("flows/a.spec.ts")), "the green bytes");
    assert.equal(textOf(snapshot.files.get("flows/b.spec.ts")), "b green");

    /* The turn rewrote both files, then the regeneration was rejected: the restore puts the prior bytes back. */
    writeFileSync(join(root.specDir, "flows", "a.spec.ts"), "rewritten, never executed");
    writeFileSync(join(root.specDir, "flows", "b.spec.ts"), "also rewritten");
    await port.restore(root.specDir, snapshot, []);

    const restored = await port.snapshot(root.specDir, ["flows/a.spec.ts", "flows/b.spec.ts"]);
    assert.equal(textOf(restored.files.get("flows/a.spec.ts")), "the green bytes");
    assert.equal(textOf(restored.files.get("flows/b.spec.ts")), "b green");
  });
});

test("a restore removes the files the turn created", async () => {
  await withRoot(async (root) => {
    mkdirSync(join(root.specDir, "flows"), { recursive: true });
    writeFileSync(join(root.specDir, "flows", "a.spec.ts"), "the green bytes");
    const port = suiteRestorePort(root, confinedSpecFiles);

    const snapshot = await port.snapshot(root.specDir, ["flows/a.spec.ts"]);
    writeFileSync(join(root.specDir, "flows", "created.spec.ts"), "created by the turn");

    await port.restore(root.specDir, snapshot, ["flows/created.spec.ts"]);

    const created = await port.snapshot(root.specDir, ["flows/created.spec.ts"]);
    assert.equal(created.files.has("flows/created.spec.ts"), false, "the created file is gone");
    const kept = await port.snapshot(root.specDir, ["flows/a.spec.ts"]);
    assert.equal(textOf(kept.files.get("flows/a.spec.ts")), "the green bytes");
  });
});

test("a snapshot that meets a symbolic link throws: a faithful before cannot be vouched for", async () => {
  await withRoot(async (root) => {
    writeFileSync(join(root.mirrorDir, "outside.txt"), "outside the spec directory");
    mkdirSync(join(root.specDir, "flows"), { recursive: true });
    symlinkSync(join(root.mirrorDir, "outside.txt"), join(root.specDir, "flows", "planted.spec.ts"));
    const port = suiteRestorePort(root, confinedSpecFiles);

    await assert.rejects(() => port.snapshot(root.specDir, ["flows/planted.spec.ts"]));
  });
});

/*
 * The snapshot covers the specs and the support files beside them, because a rejected turn must put both
 * back. A support file the confined reader refuses (too large, an odd entry) is left out rather than
 * failing the run: nothing restores it, and the specs that import it still execute. A spec is different:
 * a proof cannot rest on bytes the run could not read, so that refusal stops the acceptance.
 */
test("a support file the reader refuses is left out of the snapshot; a spec that cannot be read stops it", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "qa-snap-support-"));
  try {
    const mirror = join(tmp, "mirror");
    const specDir = join(mirror, "e2e");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "a.spec.ts"), "// a\n");
    writeFileSync(join(specDir, "fixtures.ts"), "// support\n");
    /* A support file past the reader's cap: real suites carry data files, and none of them may stop an acceptance. */
    writeFileSync(join(specDir, "seed.json"), "x".repeat(MAX_SPEC_SOURCE_BYTES + 1));
    const port = suiteRestorePort({ mirrorDir: mirror, specDir }, confinedSpecFiles);

    const snapshot = await port.snapshot(specDir, ["a.spec.ts", "fixtures.ts", "seed.json"]);
    assert.deepEqual([...snapshot.files.keys()].sort(), ["a.spec.ts", "fixtures.ts"]);

    const specTooLarge = join(specDir, "huge.spec.ts");
    writeFileSync(specTooLarge, "x".repeat(MAX_SPEC_SOURCE_BYTES + 1));
    await assert.rejects(port.snapshot(specDir, ["huge.spec.ts"]), /larger than/i, "a spec the run cannot read has no proof");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
