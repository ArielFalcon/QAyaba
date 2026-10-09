/* Some of what the agent plants in a directory outlives a run: `git clean -fd -e node_modules` leaves node_modules in place, so a named pipe, a link or a directory planted at the install marker would refuse the strict read of it on every later run for good. The orchestrator removes what refuses the read, without ever opening it or following it: a link, a named pipe, a socket, a device or a file is unlinked (the name goes; a link's target is never touched), a directory is set aside by a rename in its own parent (nothing below it is read or deleted), and a regular file is removed only when it is over the cap that refused it. It walks the path one lstat at a time from the real spec directory and stops at the first entry that is not what the read needs, so it never removes anything but a name inside the spec directory. Every case runs against real files, links and pipes under os.tmpdir(); the pipe cases run under the watch of test/support/named-pipe-watch.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfinedPathError, defaultSpecPurgeDeps, purgeRefusedPath, type SpecPurgeDeps, type SpecRoot } from "../../src/shared-infrastructure/spec-path-confinement.ts";
import { withoutWaitingOnNamedPipe } from "../support/named-pipe-watch.ts";

const PRECIOUS = "PRECIOUS: a file outside the project that nothing may remove or touch\n";
const MARKER = "node_modules/.install-hash";
const CAP = 1024;

/* <tmp>/mirror/project is the spec directory of the mirror; <tmp>/outside holds what nothing may reach. */
interface Fixture {
  tmp: string;
  mirror: string;
  project: string;
  outside: string;
  victim: string;
  root: SpecRoot;
}

async function withFixture(run: (f: Fixture) => Promise<void> | void): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-purge-"));
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
  const dir = mkdtempSync(join(tmpdir(), "qa-purge-fifo-probe-"));
  try {
    execFileSync("mkfifo", [join(dir, "probe")]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_NAMED_PIPES = canMakeNamedPipes() ? false : "mkfifo is not available on this platform, so the named-pipe cases are not exercised";
const NO_MODE_RESTRICTIONS = process.platform === "win32" || process.getuid?.() === 0 ? "the account that runs the tests is not bound by file modes, so the cases that rely on them are not exercised" : false;

const isGone = (path: string): boolean => {
  try {
    lstatSync(path);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
};

/* The real calls, with the name given to a directory that is set aside made certain. */
const deps: SpecPurgeDeps = { ...defaultSpecPurgeDeps, randomSuffix: () => "fixed" };

test("a named pipe at the marker is unlinked, never opened and never waited on", { skip: NO_NAMED_PIPES }, async () => {
  await withFixture(async (f) => {
    mkdirSync(join(f.project, "node_modules"));
    execFileSync("mkfifo", [join(f.project, MARKER)]);

    const purged = await withoutWaitingOnNamedPipe(join(f.project, MARKER), () => purgeRefusedPath(f.root, MARKER, CAP, deps));

    assert.deepEqual(purged, { removed: MARKER, how: "unlinked" });
    assert.ok(isGone(join(f.project, MARKER)));
    assert.ok(existsSync(join(f.project, "node_modules")), "and the directory it was in is left");
  });
});

test("a link at the marker is unlinked, and the file it points at is not touched", async () => {
  await withFixture((f) => {
    mkdirSync(join(f.project, "node_modules"));
    symlinkSync(f.victim, join(f.project, MARKER));

    const purged = purgeRefusedPath(f.root, MARKER, CAP, deps);

    assert.deepEqual(purged, { removed: MARKER, how: "unlinked" });
    assert.ok(isGone(join(f.project, MARKER)));
    assert.equal(readFileSync(f.victim, "utf8"), PRECIOUS);
  });
});

test("a node_modules that is a link is unlinked, and nothing in the directory it points at is touched", async () => {
  await withFixture((f) => {
    mkdirSync(join(f.outside, "nm", "pkg"), { recursive: true });
    writeFileSync(join(f.outside, "nm", ".install-hash"), "a marker");
    writeFileSync(join(f.outside, "nm", "pkg", "index.js"), "module.exports = 1;\n");
    symlinkSync(join(f.outside, "nm"), join(f.project, "node_modules"));

    const purged = purgeRefusedPath(f.root, MARKER, CAP, deps);

    assert.deepEqual(purged, { removed: "node_modules", how: "unlinked" }, "the entry that refused the read is the one that goes, not what is under it");
    assert.ok(isGone(join(f.project, "node_modules")));
    assert.deepEqual(readdirSync(join(f.outside, "nm")).sort(), [".install-hash", "pkg"], "everything outside the project is as it was");
    assert.equal(readFileSync(join(f.outside, "nm", ".install-hash"), "utf8"), "a marker");
  });
});

test("a node_modules that is a named pipe is unlinked, never opened and never waited on", { skip: NO_NAMED_PIPES }, async () => {
  await withFixture(async (f) => {
    execFileSync("mkfifo", [join(f.project, "node_modules")]);

    const purged = await withoutWaitingOnNamedPipe(join(f.project, "node_modules"), () => purgeRefusedPath(f.root, MARKER, CAP, deps));

    assert.deepEqual(purged, { removed: "node_modules", how: "unlinked" });
    assert.ok(isGone(join(f.project, "node_modules")));
  });
});

test("a node_modules that is a regular file is unlinked", async () => {
  await withFixture((f) => {
    writeFileSync(join(f.project, "node_modules"), "not a directory");

    const purged = purgeRefusedPath(f.root, MARKER, CAP, deps);

    assert.deepEqual(purged, { removed: "node_modules", how: "unlinked" });
    assert.ok(isGone(join(f.project, "node_modules")));
  });
});

test("a directory at the marker is set aside by a rename in its parent, with everything in it, and nothing is deleted", async () => {
  await withFixture((f) => {
    mkdirSync(join(f.project, MARKER, "deep"), { recursive: true });
    writeFileSync(join(f.project, MARKER, "deep", "file.txt"), "kept");

    const purged = purgeRefusedPath(f.root, MARKER, CAP, deps);

    assert.deepEqual(purged, { removed: MARKER, how: "set aside" });
    assert.ok(isGone(join(f.project, MARKER)), "the name is free");
    assert.deepEqual(readdirSync(join(f.project, "node_modules")), [".install-hash.refused-fixed"], "the directory is beside where it was");
    assert.equal(readFileSync(join(f.project, "node_modules", ".install-hash.refused-fixed", "deep", "file.txt"), "utf8"), "kept");
  });
});

test("a marker over the cap is unlinked, one of exactly the cap is not what refused the read", async () => {
  await withFixture((f) => {
    mkdirSync(join(f.project, "node_modules"));
    writeFileSync(join(f.project, MARKER), "x".repeat(CAP));
    const exact = purgeRefusedPath(f.root, MARKER, CAP, deps);
    writeFileSync(join(f.project, MARKER), "x".repeat(CAP + 1));
    const over = purgeRefusedPath(f.root, MARKER, CAP, deps);

    assert.deepEqual(exact, { nothing: true });
    assert.deepEqual(over, { removed: MARKER, how: "unlinked" });
    assert.ok(isGone(join(f.project, MARKER)));
  });
});

test("an ordinary marker in an ordinary node_modules is not removed", async () => {
  await withFixture((f) => {
    mkdirSync(join(f.project, "node_modules"));
    writeFileSync(join(f.project, MARKER), "a marker");

    const purged = purgeRefusedPath(f.root, MARKER, CAP, deps);

    assert.deepEqual(purged, { nothing: true });
    assert.equal(readFileSync(join(f.project, MARKER), "utf8"), "a marker");
  });
});

test("a path that is not there, or that stops at something that is not there, has nothing to remove", async () => {
  await withFixture((f) => {
    const noNodeModules = purgeRefusedPath(f.root, MARKER, CAP, deps);
    mkdirSync(join(f.project, "node_modules"));
    const noMarker = purgeRefusedPath(f.root, MARKER, CAP, deps);

    assert.deepEqual([noNodeModules, noMarker], [{ nothing: true }, { nothing: true }]);
    assert.ok(existsSync(join(f.project, "node_modules")));
  });
});

test("an entry set aside once is gone, so the next purge of the same path finds nothing", async () => {
  await withFixture((f) => {
    mkdirSync(join(f.project, MARKER), { recursive: true });

    const first = purgeRefusedPath(f.root, MARKER, CAP, deps);
    const second = purgeRefusedPath(f.root, MARKER, CAP, deps);

    assert.equal("removed" in first, true);
    assert.deepEqual(second, { nothing: true });
  });
});

test("a spec directory that is a link, or outside the mirror, is refused: nothing is removed under it", async () => {
  await withFixture((f) => {
    mkdirSync(join(f.outside, "project", "node_modules"), { recursive: true });
    writeFileSync(join(f.outside, "project", MARKER), "a marker");
    symlinkSync(join(f.outside, "project"), join(f.mirror, "linked-project"));

    assert.throws(() => purgeRefusedPath({ mirrorDir: f.mirror, specDir: join(f.mirror, "linked-project") }, MARKER, CAP, deps), ConfinedPathError);
    assert.throws(() => purgeRefusedPath({ mirrorDir: f.mirror, specDir: join(f.outside, "project") }, MARKER, CAP, deps), ConfinedPathError);
    assert.equal(readFileSync(join(f.outside, "project", MARKER), "utf8"), "a marker");
  });
});

test("an absolute path, a parent segment and an empty path are refused before the filesystem is asked", async () => {
  await withFixture((f) => {
    for (const rel of [f.victim, "../outside/victim.txt", "node_modules/../../outside/victim.txt", ""]) {
      assert.throws(() => purgeRefusedPath(f.root, rel, CAP, deps), ConfinedPathError, JSON.stringify(rel));
    }
    assert.equal(readFileSync(f.victim, "utf8"), PRECIOUS);
  });
});

test("empty and dot segments are no segments: a path spelled with them acts on the entry the others name, and the spec directory is never the one that goes", async () => {
  await withFixture((f) => {
    mkdirSync(join(f.project, MARKER, "deep"), { recursive: true });
    const trailing = purgeRefusedPath(f.root, `${MARKER}/`, CAP, deps);
    assert.deepEqual(trailing, { removed: MARKER, how: "set aside" }, "a trailing separator names the same directory");
    assert.ok(isGone(join(f.project, MARKER)));

    symlinkSync(f.victim, join(f.project, MARKER));
    const spelled = purgeRefusedPath(f.root, `.//node_modules/./.install-hash`, CAP, deps);
    assert.deepEqual(spelled, { removed: MARKER, how: "unlinked" }, "leading, doubled and inner dot segments name the same entry");

    for (const rel of [".", "./", "./."]) {
      assert.deepEqual(purgeRefusedPath(f.root, rel, CAP, deps), { nothing: true }, `${JSON.stringify(rel)} is the spec directory itself`);
    }
    assert.ok(lstatSync(f.project).isDirectory(), "which is still there");
    assert.equal(readFileSync(f.victim, "utf8"), PRECIOUS);
  });
});

test("a failure to look at an entry, or to remove it, is thrown as it is, never taken for nothing to remove", { skip: NO_MODE_RESTRICTIONS }, async () => {
  await withFixture((f) => {
    mkdirSync(join(f.project, "node_modules"));
    writeFileSync(join(f.project, MARKER), "x".repeat(CAP + 1));
    chmodSync(join(f.project, "node_modules"), 0o000);
    try {
      assert.throws(() => purgeRefusedPath(f.root, MARKER, CAP, deps), (err: unknown) => (err as NodeJS.ErrnoException).code === "EACCES");
    } finally {
      chmodSync(join(f.project, "node_modules"), 0o755);
    }
  });
});

test("an unlink or a rename that fails is thrown, and one that finds the entry already gone is not a failure", async () => {
  await withFixture((f) => {
    mkdirSync(join(f.project, MARKER), { recursive: true });
    const failing: SpecPurgeDeps = { ...deps, rename: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } };
    assert.throws(() => purgeRefusedPath(f.root, MARKER, CAP, failing), (err: unknown) => (err as NodeJS.ErrnoException).code === "EPERM");

    rmSync(join(f.project, MARKER), { recursive: true });
    symlinkSync(f.victim, join(f.project, MARKER));
    const gone: SpecPurgeDeps = { ...deps, unlink: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } };
    assert.deepEqual(purgeRefusedPath(f.root, MARKER, CAP, gone), { removed: MARKER, how: "unlinked" }, "removed by someone else in the meantime: the name is free, which is all that was asked");
    const failingUnlink: SpecPurgeDeps = { ...deps, unlink: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } };
    assert.throws(() => purgeRefusedPath(f.root, MARKER, CAP, failingUnlink), (err: unknown) => (err as NodeJS.ErrnoException).code === "EPERM");
  });
});

test("the directory set aside gets a name of its own each time, so two of them never collide", async () => {
  await withFixture((f) => {
    const names = new Set<string>();
    for (let i = 0; i < 3; i++) {
      mkdirSync(join(f.project, MARKER), { recursive: true });
      purgeRefusedPath(f.root, MARKER, CAP);
    }
    for (const name of readdirSync(join(f.project, "node_modules"))) names.add(name);

    assert.equal(names.size, 3);
    assert.ok([...names].every((name) => name.startsWith(".install-hash.refused-")));
  });
});
