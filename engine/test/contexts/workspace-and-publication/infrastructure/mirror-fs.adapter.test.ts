/* The mirrors root on the real file system: what is listed, measured and removed, and that nothing outside the root is touched. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsMirrorStore, getDirectorySize } from "@contexts/workspace-and-publication/infrastructure/mirror-fs.adapter.ts";
import { pruneMirrors, type MirrorPruneDeps } from "@contexts/workspace-and-publication/application/prune-mirrors.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/* The names the composition reserves; the pass reads them from its dependencies. */
const RESERVED = [".baseline", ".warm", ".qa-delegations"];

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "qa-mirror-fs-"));
}

function writeBytes(dir: string, name: string, bytes: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "x".repeat(bytes));
}

test("the size of a directory is the bytes of the regular files below it, links not followed below the top", () => {
  const scratch = scratchDir();
  try {
    const dir = join(scratch, "m");
    writeBytes(dir, "a.txt", 3);
    writeBytes(join(dir, "sub", "deeper"), "b.txt", 5);
    writeBytes(join(scratch, "outside"), "c.txt", 100);
    symlinkSync(join(scratch, "outside"), join(dir, "link-dir"));
    symlinkSync(join(scratch, "outside", "c.txt"), join(dir, "link-file"));
    assert.equal(getDirectorySize(dir), 8);
    assert.equal(getDirectorySize(join(scratch, "missing")), 0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("only directories are listed, with their modification time, and a missing root throws", () => {
  const scratch = scratchDir();
  try {
    const root = join(scratch, "mirrors");
    writeBytes(join(root, "team__front"), "a.txt", 1);
    writeFileSync(join(root, "team__file"), "not a directory");
    const when = new Date(Date.now() - 3 * DAY_MS);
    utimesSync(join(root, "team__front"), when, when);
    const listed = fsMirrorStore.listMirrorDirs(root);
    assert.deepEqual(listed.map((e) => [e.name, e.path]), [["team__front", join(root, "team__front")]]);
    assert.equal(Math.round(listed[0]!.mtimeMs), Math.round(when.getTime()));
    assert.throws(() => fsMirrorStore.listMirrorDirs(join(scratch, "missing")));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("removing a link removes the link and leaves what it points at", () => {
  const scratch = scratchDir();
  try {
    writeBytes(join(scratch, "outside"), "precious.txt", 7);
    symlinkSync(join(scratch, "outside"), join(scratch, "link"));
    fsMirrorStore.remove(join(scratch, "link"));
    assert.equal(existsSync(join(scratch, "link")), false);
    assert.ok(existsSync(join(scratch, "outside", "precious.txt")));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a pass over a real mirrors root removes what the rule picks, follows no link out of the root and counts the bytes it freed", () => {
  const scratch = scratchDir();
  try {
    const root = join(scratch, "mirrors");
    const outside = join(scratch, "outside");
    mkdirSync(root);
    writeBytes(outside, "precious.txt", 7);
    writeBytes(join(root, "team__front"), "a.txt", 11);
    writeBytes(join(root, "team__front", "node_modules", "dep"), "b.txt", 13);
    writeBytes(join(root, "team__stale"), "c.txt", 17);
    writeBytes(join(root, "gone__repo", "deep", "er"), "d.txt", 19);
    writeBytes(join(root, "owner__repo.v2"), "e.txt", 23);
    for (const name of RESERVED) writeBytes(join(root, name), "r.txt", 1);
    writeFileSync(join(root, "team__file"), "not a directory");  /* a file named like a mirror */
    symlinkSync(join(outside, "precious.txt"), join(root, "link__file"));  /* a link to a file */
    symlinkSync(outside, join(root, "link__outside"));  /* a link to a directory outside the root */
    const old = new Date(Date.now() - 8 * DAY_MS);
    utimesSync(join(root, "team__stale"), old, old);

    const logs: Array<[string, string]> = [];
    const deps: MirrorPruneDeps = {
      ...fsMirrorStore,
      mirrorRoot: root,
      reservedDirNames: RESERVED,
      configuredRepoSlugs: () => new Set(["team__front", "team__stale"]),
      activeRepoSlugs: () => new Set(),
      now: () => Date.now(),
      log: (level, message) => logs.push([level, message]),
    };
    const result = pruneMirrors(deps);

    assert.deepEqual(result.deleted.sort(), ["gone__repo", "link__outside", "owner__repo.v2", "team__stale"]);
    /* The link is measured through, as the pass always did: its target's bytes count (7), the link alone is removed. */
    assert.equal(result.freedBytes, 17 + 19 + 23 + 7);
    assert.deepEqual(readdirSync(root).sort(), [...RESERVED, "link__file", "team__file", "team__front"].sort());
    assert.ok(existsSync(join(outside, "precious.txt")), "nothing outside the root is touched");
    assert.ok(existsSync(join(root, "team__front", "node_modules", "dep", "b.txt")));
    assert.deepEqual(logs, [["info", "pruned old mirrors"]]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a pass over a mirrors root that is not there logs a warning and removes nothing", () => {
  const scratch = scratchDir();
  try {
    const logs: string[] = [];
    const result = pruneMirrors({
      ...fsMirrorStore,
      mirrorRoot: join(scratch, "missing"),
      reservedDirNames: RESERVED,
      configuredRepoSlugs: () => new Set(),
      activeRepoSlugs: () => new Set(),
      now: () => Date.now(),
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    assert.deepEqual(result, { deleted: [], freedBytes: 0 });
    assert.deepEqual(logs, ["warn:pruneMirrors: could not read mirror directory"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
