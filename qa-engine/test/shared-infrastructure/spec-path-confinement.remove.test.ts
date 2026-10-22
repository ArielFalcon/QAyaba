/* `removeOwnedSpecFile` removes a spec file the orchestrator owns — one a rejected regeneration's turn created, so the bytes on disk go back to what the run proved. It walks the path one lstat at a time like the purges, unlinks the last entry without opening or following it (a link's target is never touched, a named pipe is never waited on), refuses a directory in its place, and refuses a symbolic link on the way instead of removing it. Every case runs against real files, links and pipes under os.tmpdir(); the pipe case runs under the watch of test/support/named-pipe-watch.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfinedPathError, defaultSpecPurgeDeps, removeOwnedSpecFile, type SpecPurgeDeps, type SpecRoot } from "../../src/shared-infrastructure/spec-path-confinement.ts";
import { withoutWaitingOnNamedPipe } from "../support/named-pipe-watch.ts";

const PRECIOUS = "PRECIOUS: a file outside the project that nothing may remove or touch\n";

interface Fixture {
  tmp: string;
  mirror: string;
  project: string;
  outside: string;
  victim: string;
  root: SpecRoot;
}

async function withFixture(run: (f: Fixture) => Promise<void> | void): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-remove-"));
  const mirror = join(tmp, "mirror");
  const project = join(mirror, "project");
  const outside = join(tmp, "outside");
  mkdirSync(project, { recursive: true });
  mkdirSync(outside);
  const victim = join(outside, "victim.txt");
  writeFileSync(victim, PRECIOUS);
  try {
    await run({ tmp, mirror, project, outside, victim, root: { mirrorDir: mirror, specDir: project } });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-remove-fifo-probe-"));
  try {
    execFileSync("mkfifo", [join(dir, "probe")]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_NAMED_PIPES = canMakeNamedPipes() ? false : "mkfifo is not available on this platform, so the named-pipe case is not exercised";

const isGone = (path: string): boolean => {
  try {
    lstatSync(path);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
};

const deps: SpecPurgeDeps = { ...defaultSpecPurgeDeps, randomSuffix: () => "fixed" };

test("a regular file is unlinked", async () => {
  await withFixture((f) => {
    mkdirSync(join(f.project, "flows"));
    writeFileSync(join(f.project, "flows", "checkout.spec.ts"), "test('x', () => {});\n");

    const removed = removeOwnedSpecFile(f.root, "flows/checkout.spec.ts", deps);

    assert.deepEqual(removed, { removed: "flows/checkout.spec.ts", how: "unlinked" });
    assert.ok(isGone(join(f.project, "flows", "checkout.spec.ts")));
    assert.ok(existsSync(join(f.project, "flows")), "the directory it was in is left");
  });
});

test("a symbolic link at the path is unlinked, and the file it points at is not touched", async () => {
  await withFixture((f) => {
    symlinkSync(f.victim, join(f.project, "checkout.spec.ts"));

    const removed = removeOwnedSpecFile(f.root, "checkout.spec.ts", deps);

    assert.deepEqual(removed, { removed: "checkout.spec.ts", how: "unlinked" });
    assert.ok(isGone(join(f.project, "checkout.spec.ts")));
    assert.equal(readFileSync(f.victim, "utf8"), PRECIOUS);
  });
});

test("a symbolic link above the file is refused, never removed: nothing behind it is touched", async () => {
  await withFixture((f) => {
    mkdirSync(join(f.outside, "flows"));
    writeFileSync(join(f.outside, "flows", "checkout.spec.ts"), "test('x', () => {});\n");
    symlinkSync(join(f.outside, "flows"), join(f.project, "flows"));

    assert.throws(() => removeOwnedSpecFile(f.root, "flows/checkout.spec.ts", deps), ConfinedPathError);
    assert.ok(existsSync(join(f.project, "flows")), "the link itself is left");
    assert.equal(readFileSync(join(f.outside, "flows", "checkout.spec.ts"), "utf8"), "test('x', () => {});\n");
  });
});

test("a named pipe at the path is unlinked, never opened and never waited on", { skip: NO_NAMED_PIPES }, async () => {
  await withFixture(async (f) => {
    execFileSync("mkfifo", [join(f.project, "checkout.spec.ts")]);

    const removed = await withoutWaitingOnNamedPipe(join(f.project, "checkout.spec.ts"), () => removeOwnedSpecFile(f.root, "checkout.spec.ts", deps));

    assert.deepEqual(removed, { removed: "checkout.spec.ts", how: "unlinked" });
    assert.ok(isGone(join(f.project, "checkout.spec.ts")));
  });
});

test("a path that is not there, or whose directory is not there, has nothing to remove", async () => {
  await withFixture((f) => {
    const noFile = removeOwnedSpecFile(f.root, "checkout.spec.ts", deps);
    mkdirSync(join(f.project, "flows"));
    const noParent = removeOwnedSpecFile(f.root, "flows/checkout.spec.ts", deps);

    assert.deepEqual([noFile, noParent], [{ nothing: true }, { nothing: true }]);
    assert.ok(existsSync(join(f.project, "flows")));
  });
});

test("an absolute path, a parent segment and an empty path are refused before the filesystem is asked", async () => {
  await withFixture((f) => {
    for (const rel of [f.victim, "../outside/victim.txt", "flows/../../outside/victim.txt", ""]) {
      assert.throws(() => removeOwnedSpecFile(f.root, rel, deps), ConfinedPathError, JSON.stringify(rel));
    }
    assert.equal(readFileSync(f.victim, "utf8"), PRECIOUS);
  });
});

test("a directory in the place of the file is refused and left as it is, never set aside or descended into", async () => {
  await withFixture((f) => {
    mkdirSync(join(f.project, "checkout.spec.ts", "deep"), { recursive: true });
    writeFileSync(join(f.project, "checkout.spec.ts", "deep", "file.txt"), "kept");

    assert.throws(() => removeOwnedSpecFile(f.root, "checkout.spec.ts", deps), ConfinedPathError);
    assert.ok(existsSync(join(f.project, "checkout.spec.ts")), "the directory is left");
    assert.equal(readFileSync(join(f.project, "checkout.spec.ts", "deep", "file.txt"), "utf8"), "kept");
  });
});

test("a spec directory that is a link is refused: nothing under it is removed", async () => {
  await withFixture((f) => {
    mkdirSync(join(f.outside, "project", "flows"), { recursive: true });
    writeFileSync(join(f.outside, "project", "checkout.spec.ts"), "test('x', () => {});\n");
    symlinkSync(join(f.outside, "project"), join(f.mirror, "linked-project"));

    assert.throws(() => removeOwnedSpecFile({ mirrorDir: f.mirror, specDir: join(f.mirror, "linked-project") }, "checkout.spec.ts", deps), ConfinedPathError);
    assert.equal(readFileSync(join(f.outside, "project", "checkout.spec.ts"), "utf8"), "test('x', () => {});\n");
  });
});

test("an unlink that fails is thrown, and one that finds the entry already gone is not a failure", async () => {
  await withFixture((f) => {
    writeFileSync(join(f.project, "checkout.spec.ts"), "test('x', () => {});\n");
    const failing: SpecPurgeDeps = { ...deps, unlink: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } };
    assert.throws(() => removeOwnedSpecFile(f.root, "checkout.spec.ts", failing), (err: unknown) => (err as NodeJS.ErrnoException).code === "EPERM");

    const gone: SpecPurgeDeps = { ...deps, unlink: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } };
    assert.deepEqual(removeOwnedSpecFile(f.root, "checkout.spec.ts", gone), { removed: "checkout.spec.ts", how: "unlinked" });
  });
});
