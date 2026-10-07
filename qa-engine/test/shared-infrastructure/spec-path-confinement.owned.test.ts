/* Some files are the orchestrator's own and sit in a directory the agent writes into: the manifest, in `.qa` below the spec directory. The agent can plant a symlink or a named pipe at the file or at the directory above it, so reading follows the plant to a file the orchestrator can read and writing follows it to a file the orchestrator can clobber. These files are read and written strictly: no symlink anywhere below the spec directory, a regular file at the end, and a write that goes through a temporary file renamed over the target, so that nothing is ever written through a link. Every fixture lives under os.tmpdir(), with real symlinks and real pipes; the swaps are made by the test at the injected seam. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  ConfinedPathError,
  MAX_SPEC_SOURCE_BYTES,
  defaultSpecReadDeps,
  defaultSpecWriteDeps,
  readOwnedSpecFile,
  specWriteDepsFor,
  writeOwnedSpecFile,
  type SpecReadDeps,
  type SpecRoot,
  type SpecWriteDeps,
} from "../../src/shared-infrastructure/spec-path-confinement.ts";
import { withoutWaitingOnNamedPipe } from "../support/named-pipe-watch.ts";

const REL = ".qa/manifest.json";

/* <tmp>/mirror/e2e is the suite; <tmp>/outside holds what no read or write may reach, victim.txt among it. */
interface Suite {
  tmp: string;
  mirror: string;
  specDir: string;
  qa: string;
  file: string;
  outside: string;
  root: SpecRoot;
}

function makeSuite(): { suite: Suite; remove: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "qa-owned-"));
  const mirror = join(tmp, "mirror");
  const specDir = join(mirror, "e2e");
  mkdirSync(specDir, { recursive: true });
  mkdirSync(join(tmp, "outside"));
  writeFileSync(join(tmp, "outside", "victim.txt"), "PRECIOUS");
  writeFileSync(join(tmp, "outside", "manifest.json"), '[{"id":"leaked"}]');
  return {
    suite: { tmp, mirror, specDir, qa: join(specDir, ".qa"), file: join(specDir, ".qa", "manifest.json"), outside: join(tmp, "outside"), root: { mirrorDir: mirror, specDir } },
    remove: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

function withSuite(run: (suite: Suite) => void): void {
  const { suite, remove } = makeSuite();
  try {
    run(suite);
  } finally {
    remove();
  }
}

async function withSuiteAsync(run: (suite: Suite) => Promise<void>): Promise<void> {
  const { suite, remove } = makeSuite();
  try {
    await run(suite);
  } finally {
    remove();
  }
}

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-owned-fifo-probe-"));
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

/* A directory whose mode is 000 cannot be searched by an account that the mode binds: not by root, and not on a platform without modes. */
const NO_MODE_RESTRICTIONS = process.platform === "win32" || process.getuid?.() === 0 ? "the account that runs the tests is not bound by directory modes, so the cases that rely on them are not exercised" : false;

/* A refusal names the path as it was given and always says why. */
const refusedAs = (rel: string) => (err: unknown): boolean => err instanceof ConfinedPathError && err.path === rel && err.reason !== "";

/* The write seam with the real calls and a temporary name the test knows. */
const KNOWN: SpecWriteDeps = { ...defaultSpecWriteDeps, randomSuffix: () => "t0" };

/* Without a kernel path, as on macOS: what is under test is the second look at the path. */
const WITHOUT_KERNEL_PATH: SpecWriteDeps = { ...KNOWN, fdPath: () => undefined };

const temporaryFilesIn = (dir: string): string[] => readdirSync(dir).filter((name) => name.endsWith(".tmp"));

function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    assert.ok(err instanceof ConfinedPathError, `a ConfinedPathError was expected, got ${String(err)}`);
    return err.reason;
  }
  return assert.fail("nothing was refused");
}

/* A closed descriptor answers EBADF; nothing else in a synchronous test opens a descriptor between the refusal and this look. */
function assertReleased(fd: number): void {
  assert.notEqual(fd, -1, "the descriptor was opened");
  assert.throws(() => fstatSync(fd), /EBADF/, "the descriptor was released");
}

/* ── reading an owned file ─────────────────────────────────────────────────────────────────────── */

test("an owned file that is not there is absent, whether its directory is missing or only the file", () => {
  withSuite((s) => {
    assert.deepEqual(readOwnedSpecFile(s.root, REL, 1024), { absent: true });
    mkdirSync(s.qa);
    assert.deepEqual(readOwnedSpecFile(s.root, REL, 1024), { absent: true });
  });
});

test("an owned file that is a regular file in ordinary directories is read, however deep", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    writeFileSync(s.file, '[{"id":"real"}]');
    mkdirSync(join(s.specDir, "a", "b"), { recursive: true });
    writeFileSync(join(s.specDir, "a", "b", "c.json"), "deep");

    const manifest = readOwnedSpecFile(s.root, REL, 1024);
    const deep = readOwnedSpecFile(s.root, "a\\b/c.json", 1024);
    const allBackslashes = readOwnedSpecFile(s.root, "a\\b\\c.json", 1024);

    assert.ok("bytes" in manifest && manifest.bytes.toString("utf8") === '[{"id":"real"}]');
    assert.ok("bytes" in deep && deep.bytes.toString("utf8") === "deep");
    assert.ok("bytes" in allBackslashes && allBackslashes.bytes.toString("utf8") === "deep", "every backslash is a separator, not only the first");
  });
});

test("an owned file reached through a symlink anywhere is refused and never read, whatever the symlink points at", () => {
  withSuite((s) => {
    mkdirSync(join(s.specDir, "inside"));
    writeFileSync(join(s.specDir, "inside", "manifest.json"), '[{"id":"inside"}]');
    const cases: Array<[string, () => void]> = [
      ["the directory is a symlink to a directory outside the mirror", () => symlinkSync(s.outside, s.qa)],
      ["the directory is a symlink to a directory inside the spec directory", () => symlinkSync(join(s.specDir, "inside"), s.qa)],
      ["the file is a symlink to a file outside the mirror", () => { mkdirSync(s.qa); symlinkSync(join(s.outside, "manifest.json"), s.file); }],
      ["the file is a symlink to a file inside the spec directory", () => { mkdirSync(s.qa); symlinkSync(join(s.specDir, "inside", "manifest.json"), s.file); }],
      ["the file is a symlink to nothing", () => { mkdirSync(s.qa); symlinkSync(join(s.outside, "no-such-file"), s.file); }],
    ];
    for (const [what, plant] of cases) {
      plant();
      const read = readOwnedSpecFile(s.root, REL, 1024);
      assert.ok("reason" in read && read.reason !== "", what);
      rmSync(s.qa, { recursive: true, force: true });
    }
  });
});

test("an owned file whose directory or file is not what it should be is refused: a regular file for the directory, a directory or a named pipe for the file", () => {
  withSuite((s) => {
    writeFileSync(s.qa, "not a directory");
    assert.ok("reason" in readOwnedSpecFile(s.root, REL, 1024), "the directory is a regular file");
    rmSync(s.qa);
    mkdirSync(s.file, { recursive: true });
    assert.ok("reason" in readOwnedSpecFile(s.root, REL, 1024), "the file is a directory");
  });
});

/* The named-pipe cases run under a watch: a read that opened the pipe would wait for a writer for ever, and a test cannot time out a thread that is stuck, so the watch releases it and the test fails there instead. */
test("an owned file that is a named pipe is refused without being opened", { skip: NO_NAMED_PIPES }, async () => {
  await withSuiteAsync(async (s) => {
    mkdirSync(s.qa);
    execFileSync("mkfifo", [s.file]);

    const read = await withoutWaitingOnNamedPipe(s.file, () => readOwnedSpecFile(s.root, REL, 1024));

    assert.ok("reason" in read && read.reason !== "");
  });
});

test("an owned file in a directory that cannot be searched is refused, not taken for absent", { skip: NO_MODE_RESTRICTIONS }, () => {
  withSuite((s) => {
    mkdirSync(join(s.specDir, "a", "b"), { recursive: true });
    mkdirSync(s.qa);
    writeFileSync(s.file, "[]");
    chmodSync(s.qa, 0o000);
    chmodSync(join(s.specDir, "a"), 0o000);
    try {
      const file = readOwnedSpecFile(s.root, REL, 1024);
      const directory = readOwnedSpecFile(s.root, "a/b/c.json", 1024);

      assert.ok("reason" in file && file.reason !== "", "the file in a directory that cannot be searched");
      assert.ok("reason" in directory && directory.reason !== "", "a directory below one that cannot be searched");
    } finally {
      chmodSync(s.qa, 0o755);
      chmodSync(join(s.specDir, "a"), 0o755);
    }
  });
});

test("a file that cannot be examined is refused for a reason of its own, apart from a link above it or a directory in its place", { skip: NO_MODE_RESTRICTIONS }, () => {
  withSuite((s) => {
    mkdirSync(join(s.specDir, "d"));
    mkdirSync(s.qa);
    writeFileSync(s.file, "[]");
    symlinkSync(s.outside, join(s.specDir, "link"));
    const reasonOfRead = (rel: string): string => {
      const read = readOwnedSpecFile(s.root, rel, 1024);
      assert.ok("reason" in read, rel);
      return read.reason;
    };
    chmodSync(s.qa, 0o000);
    try {
      const cannotBeExamined = reasonOfRead(REL);
      const inTheWay = [reasonOfRead("link/manifest.json"), reasonOfRead("d")];

      assert.equal(inTheWay.includes(cannotBeExamined), false, `${cannotBeExamined} is also the reason of a link or a directory in the way: ${JSON.stringify(inTheWay)}`);
      assert.equal(inTheWay[0] === inTheWay[1], false, "a link above the file and a directory in place of it are told apart too");
    } finally {
      chmodSync(s.qa, 0o755);
    }
  });
});

test("an owned file is the same file however its path is spelled: empty and dot segments are no segments", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    writeFileSync(s.file, "same");

    for (const spelled of [".qa//manifest.json", "./.qa/manifest.json", ".qa/./manifest.json", ".qa\\manifest.json", ".//.qa///manifest.json"]) {
      const read = readOwnedSpecFile(s.root, spelled, 1024);
      assert.ok("bytes" in read && read.bytes.toString("utf8") === "same", spelled);
    }
    for (const spelled of [".", ".qa", ".qa/", "./.qa/."]) {
      assert.ok("reason" in readOwnedSpecFile(s.root, spelled, 1024), `${spelled} names a directory, not a file`);
    }
  });
});

test("an owned file is refused when the spec directory is a symlink, leaves the mirror or is missing", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    writeFileSync(s.file, "[]");
    symlinkSync(s.specDir, join(s.mirror, "e2e-link"));
    for (const root of [
      { mirrorDir: s.mirror, specDir: join(s.mirror, "e2e-link") },
      { mirrorDir: join(s.tmp, "elsewhere-mirror"), specDir: s.specDir },
      { mirrorDir: s.mirror, specDir: join(s.mirror, "no-such-dir") },
    ]) {
      assert.ok("reason" in readOwnedSpecFile(root, REL, 1024), JSON.stringify(root));
    }
  });
});

test("an owned file is refused for an empty, absolute or parent-bearing path", () => {
  withSuite((s) => {
    for (const rel of ["", "/manifest.json", "../manifest.json", ".qa/../../manifest.json", "."]) {
      assert.ok("reason" in readOwnedSpecFile(s.root, rel, 1024), JSON.stringify(rel));
    }
  });
});

test("an owned file larger than the cap is refused, one of exactly the cap is read", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    writeFileSync(s.file, "x".repeat(MAX_SPEC_SOURCE_BYTES + 1));
    assert.ok("reason" in readOwnedSpecFile(s.root, REL, MAX_SPEC_SOURCE_BYTES));
    const read = readOwnedSpecFile(s.root, REL, MAX_SPEC_SOURCE_BYTES + 1);
    assert.ok("bytes" in read && read.bytes.length === MAX_SPEC_SOURCE_BYTES + 1, "an explicit cap above the file reads it");
  });
});

test("an owned file whose directory is swapped for a symlink just before the open is refused by the read itself, not returned", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    writeFileSync(s.file, '[{"id":"real"}]');
    const deps: SpecReadDeps = {
      ...defaultSpecReadDeps,
      fdPath: () => undefined,
      open: (path, flags) => {
        renameSync(s.qa, `${s.qa}-moved`);
        symlinkSync(s.outside, s.qa);
        return defaultSpecReadDeps.open(path, flags);
      },
    };

    const read = readOwnedSpecFile(s.root, REL, 1024, deps);

    assert.ok("reason" in read, "the swap is a refusal, never the outside file's bytes");
    assert.equal(readFileSync(s.file, "utf8"), '[{"id":"leaked"}]', "the swap did redirect the path");
  });
});

/* ── writing an owned file ─────────────────────────────────────────────────────────────────────── */

test("writing creates the directory and the file when neither is there, and leaves no temporary file", () => {
  withSuite((s) => {
    writeOwnedSpecFile(s.root, REL, '[{"id":"first"}]');

    assert.equal(readFileSync(s.file, "utf8"), '[{"id":"first"}]');
    assert.equal(lstatSync(s.qa).isDirectory(), true);
    assert.deepEqual(temporaryFilesIn(s.qa), []);
  });
});

test("writing creates every directory above the file, however deep, and replaces a file that is already there", () => {
  withSuite((s) => {
    writeOwnedSpecFile(s.root, "a/b\\c/deep.json", "one");
    writeOwnedSpecFile(s.root, "a/b/c/deep.json", "two");
    writeOwnedSpecFile(s.root, "x\\y\\z\\other.json", "three");

    assert.equal(readFileSync(join(s.specDir, "a", "b", "c", "deep.json"), "utf8"), "two");
    assert.equal(readFileSync(join(s.specDir, "x", "y", "z", "other.json"), "utf8"), "three", "every backslash is a separator, not only the first");
    assert.deepEqual(temporaryFilesIn(join(s.specDir, "a", "b", "c")), []);
  });
});

test("writing replaces the content as a whole: an old file longer than the new one leaves nothing of itself behind", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    writeFileSync(s.file, "x".repeat(500));

    writeOwnedSpecFile(s.root, REL, "short");

    assert.equal(readFileSync(s.file, "utf8"), "short");
  });
});

test("writing through a symlink at the file never touches what it points at, and says so", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    symlinkSync(join(s.outside, "victim.txt"), s.file);

    assert.throws(() => writeOwnedSpecFile(s.root, REL, "CLOBBER"), refusedAs(REL));

    assert.equal(readFileSync(join(s.outside, "victim.txt"), "utf8"), "PRECIOUS");
    assert.equal(lstatSync(s.file).isSymbolicLink(), true, "the planted link is left as it was");
    assert.deepEqual(temporaryFilesIn(s.qa), []);
  });
});

test("writing through a symlink at the file that points at nothing never creates its target", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    symlinkSync(join(s.outside, "not-yet"), s.file);

    assert.throws(() => writeOwnedSpecFile(s.root, REL, "CLOBBER"), refusedAs(REL));

    assert.deepEqual(readdirSync(s.outside).sort(), ["manifest.json", "victim.txt"]);
  });
});

test("writing through a symlink at the directory, out of the mirror or inside it, writes nothing anywhere", () => {
  withSuite((s) => {
    mkdirSync(join(s.specDir, "inside"));
    for (const target of [s.outside, join(s.specDir, "inside")]) {
      symlinkSync(target, s.qa);

      assert.throws(() => writeOwnedSpecFile(s.root, REL, "CLOBBER"), refusedAs(REL), target);

      assert.deepEqual(readdirSync(s.outside).sort(), ["manifest.json", "victim.txt"], "nothing is written outside");
      assert.deepEqual(readdirSync(join(s.specDir, "inside")), [], "nor in the directory it points at inside");
      assert.equal(readFileSync(join(s.outside, "manifest.json"), "utf8"), '[{"id":"leaked"}]');
      unlinkSync(s.qa);
    }
  });
});

test("writing is refused when the directory is a regular file or the file is a directory, and the first is left as it is", () => {
  withSuite((s) => {
    writeFileSync(s.qa, "not a directory");
    assert.throws(() => writeOwnedSpecFile(s.root, REL, "x"), refusedAs(REL));
    assert.equal(readFileSync(s.qa, "utf8"), "not a directory");
    rmSync(s.qa);
    mkdirSync(s.file, { recursive: true });
    assert.throws(() => writeOwnedSpecFile(s.root, REL, "x"), refusedAs(REL));
    assert.equal(lstatSync(s.file).isDirectory(), true);
  });
});

test("writing is refused for a named pipe at the file, which is not opened", { skip: NO_NAMED_PIPES }, async () => {
  await withSuiteAsync(async (s) => {
    mkdirSync(s.qa);
    execFileSync("mkfifo", [s.file]);

    await assert.rejects(withoutWaitingOnNamedPipe(s.file, () => writeOwnedSpecFile(s.root, REL, "x")), refusedAs(REL));

    assert.equal(lstatSync(s.file).isFIFO(), true);
  });
});

test("writing in a directory that cannot be searched is refused, and creates nothing", { skip: NO_MODE_RESTRICTIONS }, () => {
  withSuite((s) => {
    mkdirSync(join(s.specDir, "a", "b"), { recursive: true });
    mkdirSync(s.qa);
    chmodSync(s.qa, 0o000);
    chmodSync(join(s.specDir, "a"), 0o000);
    try {
      assert.throws(() => writeOwnedSpecFile(s.root, REL, "x"), refusedAs(REL), "the file in a directory that cannot be searched");
      assert.throws(() => writeOwnedSpecFile(s.root, "a/b/c.json", "x"), refusedAs("a/b/c.json"), "a directory below one that cannot be searched");
    } finally {
      chmodSync(s.qa, 0o755);
      chmodSync(join(s.specDir, "a"), 0o755);
    }
    assert.deepEqual(readdirSync(s.qa), []);
    assert.deepEqual(readdirSync(join(s.specDir, "a", "b")), []);
  });
});

test("writing a file spelled with empty and dot segments writes the file those segments name", () => {
  withSuite((s) => {
    writeOwnedSpecFile(s.root, "./.qa//manifest.json", "one");
    assert.equal(readFileSync(s.file, "utf8"), "one");
    writeOwnedSpecFile(s.root, ".qa/./manifest.json", "two");
    assert.equal(readFileSync(s.file, "utf8"), "two");
    assert.deepEqual(readdirSync(s.qa), ["manifest.json"]);
  });
});

test("writing is refused when the spec directory is a symlink, leaves the mirror or is missing, and creates nothing", () => {
  withSuite((s) => {
    symlinkSync(s.specDir, join(s.mirror, "e2e-link"));
    for (const root of [
      { mirrorDir: s.mirror, specDir: join(s.mirror, "e2e-link") },
      { mirrorDir: join(s.tmp, "elsewhere-mirror"), specDir: s.specDir },
      { mirrorDir: s.mirror, specDir: join(s.mirror, "no-such-dir") },
    ]) {
      assert.throws(() => writeOwnedSpecFile(root, REL, "x"), refusedAs(REL), JSON.stringify(root));
    }
    assert.deepEqual(readdirSync(s.specDir), [], "the spec directory was not touched");
  });
});

test("writing is refused for an empty, absolute or parent-bearing path", () => {
  withSuite((s) => {
    for (const rel of ["", "/manifest.json", "../manifest.json", ".qa/../../manifest.json", "."]) {
      assert.throws(() => writeOwnedSpecFile(s.root, rel, "x"), refusedAs(rel), JSON.stringify(rel));
    }
    assert.deepEqual(readdirSync(s.mirror), ["e2e"]);
  });
});

test("the temporary file is created exclusively and without following a link: a name a symlink already holds is an error, and the link is left alone", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    symlinkSync(join(s.outside, "victim.txt"), join(s.qa, "manifest.json.t0.tmp"));

    assert.throws(() => writeOwnedSpecFile(s.root, REL, "CLOBBER", KNOWN), (err: unknown) => err instanceof Error && (err as NodeJS.ErrnoException).code === "EEXIST");

    assert.equal(readFileSync(join(s.outside, "victim.txt"), "utf8"), "PRECIOUS");
    assert.equal(lstatSync(join(s.qa, "manifest.json.t0.tmp")).isSymbolicLink(), true, "what was not made here is not removed here");
  });
});

test("the temporary file is opened for writing only, created, exclusive and without following a link, readable by others", () => {
  withSuite((s) => {
    const seen: Array<{ path: string; flags: number; mode: number }> = [];
    const deps: SpecWriteDeps = { ...WITHOUT_KERNEL_PATH, open: (path, flags, mode) => { seen.push({ path, flags, mode }); return defaultSpecWriteDeps.open(path, flags, mode); } };

    writeOwnedSpecFile(s.root, REL, "x", deps);

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.path, join(realpathSync(s.specDir), ".qa", "manifest.json.t0.tmp"));
    const flags = seen[0]!.flags;
    assert.notEqual(flags & constants.O_WRONLY, 0, "for writing");
    assert.equal(flags & constants.O_RDWR, 0, "not for reading");
    for (const flag of [constants.O_CREAT, constants.O_EXCL, constants.O_NOFOLLOW]) assert.notEqual(flags & flag, 0);
    assert.equal(seen[0]!.mode & 0o044, 0o044, "a reader of another account can read what was written");
    assert.equal(seen[0]!.mode & 0o022, 0, "and no other account can write it");
    assert.equal(seen[0]!.mode & 0o111, 0, "and nobody can run it");
  });
});

test("a refusal after the temporary file exists removes it, releases the descriptor and leaves the old file as it was", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    writeFileSync(s.file, "OLD");
    const opened = { fd: -1 };
    const deps: SpecWriteDeps = {
      ...WITHOUT_KERNEL_PATH,
      open: (path, flags, mode) => (opened.fd = defaultSpecWriteDeps.open(path, flags, mode)),
      /* The file is swapped for a symlink to a victim after the temporary file exists, which the second look then sees. */
      fdPath: () => {
        unlinkSync(s.file);
        symlinkSync(join(s.outside, "victim.txt"), s.file);
        return undefined;
      },
    };

    assert.throws(() => writeOwnedSpecFile(s.root, REL, "NEW", deps), refusedAs(REL));

    assert.equal(readFileSync(join(s.outside, "victim.txt"), "utf8"), "PRECIOUS");
    assert.deepEqual(temporaryFilesIn(s.qa), []);
    assertReleased(opened.fd);
  });
});

test("a directory swapped for a symlink out of the spec directory after the temporary file is created is refused by the second look, and what was made there is removed", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    const deps: SpecWriteDeps = {
      ...WITHOUT_KERNEL_PATH,
      open: (path, flags, mode) => {
        renameSync(s.qa, `${s.qa}-moved`);
        symlinkSync(s.outside, s.qa);
        return defaultSpecWriteDeps.open(path, flags, mode);
      },
    };

    assert.throws(() => writeOwnedSpecFile(s.root, REL, "CLOBBER", deps), refusedAs(REL));

    assert.deepEqual(readdirSync(s.outside).sort(), ["manifest.json", "victim.txt"], "the temporary file made through the link is gone, and no manifest was written");
    assert.equal(readFileSync(join(s.outside, "manifest.json"), "utf8"), '[{"id":"leaked"}]');
  });
});

test("a directory removed after the temporary file is created is refused by the second look, which does not make it again", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    const deps: SpecWriteDeps = {
      ...WITHOUT_KERNEL_PATH,
      open: (path, flags, mode) => {
        const fd = defaultSpecWriteDeps.open(path, flags, mode);
        rmSync(s.qa, { recursive: true });
        return fd;
      },
    };

    assert.throws(() => writeOwnedSpecFile(s.root, REL, "x", deps), refusedAs(REL));

    assert.equal(existsSync(s.qa), false, "a second look is a look: it makes nothing");
  });
});

test("an ancestor of the spec directory swapped for a link to another directory of the mirror after the temporary file is created is refused: the write would land elsewhere", () => {
  withSuite((s) => {
    const nested: SpecRoot = { mirrorDir: s.mirror, specDir: join(s.mirror, "x", "e2e") };
    mkdirSync(join(nested.specDir, ".qa"), { recursive: true });
    mkdirSync(join(s.mirror, "y", "e2e", ".qa"), { recursive: true });
    const deps: SpecWriteDeps = {
      ...WITHOUT_KERNEL_PATH,
      open: (path, flags, mode) => {
        const fd = defaultSpecWriteDeps.open(path, flags, mode);
        renameSync(join(s.mirror, "x"), join(s.mirror, "x-moved"));
        symlinkSync(join(s.mirror, "y"), join(s.mirror, "x"));
        return fd;
      },
    };

    assert.throws(() => writeOwnedSpecFile(nested, REL, "x", deps), refusedAs(REL));

    assert.deepEqual(readdirSync(join(s.mirror, "y", "e2e", ".qa")), [], "nothing was written where the swap led");
  });
});

test("a temporary file the kernel says is not where it was asked for is refused, removed where it landed, and the descriptor is released", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    writeFileSync(s.file, "OLD");
    const landedIn = join(realpathSync(s.outside));
    const opened = { fd: -1 };
    const deps: SpecWriteDeps = {
      ...KNOWN,
      /* The open lands in another directory, as it would if a directory above had been swapped, and the kernel says where. */
      open: (path, flags, mode) => (opened.fd = defaultSpecWriteDeps.open(join(landedIn, basename(path)), flags, mode)),
      fdPath: () => join(landedIn, "manifest.json.t0.tmp"),
    };

    assert.throws(() => writeOwnedSpecFile(s.root, REL, "NEW", deps), refusedAs(REL));

    assert.deepEqual(readdirSync(landedIn).sort(), ["manifest.json", "victim.txt"], "the file made elsewhere is removed there");
    assert.equal(readFileSync(s.file, "utf8"), "OLD");
    assertReleased(opened.fd);
  });
});

test("a temporary file the kernel places where it was asked for is written, and where the platform has no path the second look decides alone", () => {
  withSuite((s) => {
    const placed: SpecWriteDeps = { ...KNOWN, fdPath: () => join(realpathSync(s.specDir), ".qa", "manifest.json.t0.tmp") };
    writeOwnedSpecFile(s.root, REL, "kernel says so", placed);
    assert.equal(readFileSync(s.file, "utf8"), "kernel says so");

    writeOwnedSpecFile(s.root, REL, "no kernel path", WITHOUT_KERNEL_PATH);
    assert.equal(readFileSync(s.file, "utf8"), "no kernel path");
  });
});

test("a failure to read the kernel path is thrown as it is, the descriptor is released and the temporary file is removed", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    const opened = { fd: -1 };
    const deps: SpecWriteDeps = {
      ...KNOWN,
      open: (path, flags, mode) => (opened.fd = defaultSpecWriteDeps.open(path, flags, mode)),
      fdPath: () => { throw new Error("procfs is gone"); },
    };

    assert.throws(() => writeOwnedSpecFile(s.root, REL, "x", deps), /procfs is gone/);

    assert.deepEqual(temporaryFilesIn(s.qa), []);
    assertReleased(opened.fd);
  });
});

/* A close that reports a failure: the descriptor really is released, so that the test leaks none. */
const closeThatFails = (fd: number): void => {
  closeSync(fd);
  throw new Error("close failed");
};

test("a descriptor that fails to close is thrown as it is, the temporary file is removed and never put in place", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    writeFileSync(s.file, "OLD");
    const renamedTo: string[] = [];
    const deps: SpecWriteDeps = {
      ...WITHOUT_KERNEL_PATH,
      close: closeThatFails,
      rename: (from, to) => {
        renamedTo.push(to);
        defaultSpecWriteDeps.rename(from, to);
      },
    };

    assert.throws(() => writeOwnedSpecFile(s.root, REL, "NEW", deps), /close failed/);

    assert.deepEqual(renamedTo, [], "a file whose close failed may not have been written out, so it is not put in place");
    assert.equal(readFileSync(s.file, "utf8"), "OLD");
    assert.deepEqual(temporaryFilesIn(s.qa), []);
  });
});

test("a descriptor that fails to close does not hide the refusal that was in flight, and the temporary file is removed all the same", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    writeFileSync(s.file, "OLD");
    const deps: SpecWriteDeps = {
      ...WITHOUT_KERNEL_PATH,
      close: closeThatFails,
      /* The file is swapped for a symlink to a victim after the temporary file exists, which the second look then refuses. */
      fdPath: () => {
        unlinkSync(s.file);
        symlinkSync(join(s.outside, "victim.txt"), s.file);
        return undefined;
      },
    };

    assert.throws(() => writeOwnedSpecFile(s.root, REL, "NEW", deps), refusedAs(REL));

    assert.equal(readFileSync(join(s.outside, "victim.txt"), "utf8"), "PRECIOUS");
    assert.deepEqual(temporaryFilesIn(s.qa), []);
  });
});

test("a descriptor that fails to close does not stop the removal of a temporary file the kernel put elsewhere", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    const landedIn = realpathSync(s.outside);
    const deps: SpecWriteDeps = {
      ...KNOWN,
      close: closeThatFails,
      open: (path, flags, mode) => defaultSpecWriteDeps.open(join(landedIn, basename(path)), flags, mode),
      fdPath: () => join(landedIn, "manifest.json.t0.tmp"),
    };

    assert.throws(() => writeOwnedSpecFile(s.root, REL, "NEW", deps), refusedAs(REL));

    assert.deepEqual(readdirSync(landedIn).sort(), ["manifest.json", "victim.txt"], "the file made elsewhere is removed there");
  });
});

test("a rename that fails removes the temporary file, throws the failure as it is and leaves the old file as it was", () => {
  withSuite((s) => {
    mkdirSync(s.qa);
    writeFileSync(s.file, "OLD");
    const deps: SpecWriteDeps = { ...WITHOUT_KERNEL_PATH, rename: () => { throw new Error("rename failed"); } };

    assert.throws(() => writeOwnedSpecFile(s.root, REL, "NEW", deps), /rename failed/);

    assert.equal(readFileSync(s.file, "utf8"), "OLD");
    assert.deepEqual(temporaryFilesIn(s.qa), []);
  });
});

test("the temporary name is different every time and safe in a file name, and a write with the real calls leaves nothing behind", () => {
  const a = defaultSpecWriteDeps.randomSuffix();
  const b = defaultSpecWriteDeps.randomSuffix();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  withSuite((s) => {
    writeOwnedSpecFile(s.root, REL, "one");
    writeOwnedSpecFile(s.root, REL, "two");
    assert.equal(readFileSync(s.file, "utf8"), "two");
    assert.deepEqual(readdirSync(s.qa), ["manifest.json"]);
  });
});

test("the kernel path comes from procfs on Linux and from nowhere on the other platforms, for a write as for a read", () => {
  const asked: string[] = [];
  const readlink = (path: string): string => {
    asked.push(path);
    return `/real${path}`;
  };

  assert.equal(specWriteDepsFor("linux", readlink).fdPath(9), "/real/proc/self/fd/9");
  assert.deepEqual(asked, ["/proc/self/fd/9"]);
  for (const platform of ["darwin", "win32", "freebsd"] as const) {
    assert.equal(specWriteDepsFor(platform, readlink).fdPath(9), undefined, platform);
  }
  assert.equal(asked.length, 1);
});

test("every refusal of an owned file says why in its own words, apart from the others", () => {
  withSuite((s) => {
    const refusals: string[] = [];
    const reasonOfRead = (root: SpecRoot, rel: string): string => {
      const read = readOwnedSpecFile(root, rel, 1024);
      assert.ok("reason" in read);
      return read.reason;
    };
    symlinkSync(s.outside, s.qa);
    refusals.push(reasonOfRead(s.root, REL)); /* a directory that is a symlink */
    unlinkSync(s.qa);
    mkdirSync(s.qa);
    mkdirSync(s.file);
    refusals.push(reasonOfRead(s.root, REL)); /* a file that is a directory */
    refusals.push(reasonOfRead(s.root, "")); /* an empty path */
    refusals.push(reasonOfRead({ mirrorDir: s.mirror, specDir: join(s.mirror, "no-such-dir") }, REL)); /* a spec directory that is missing */
    refusals.push(reasonOf(() => writeOwnedSpecFile(s.root, REL, "x"))); /* a write through the directory of a file that is a directory */

    for (const reason of refusals) assert.notEqual(reason, "");
    assert.equal(new Set(refusals.slice(0, 4)).size, 4, `two refusals share a reason: ${JSON.stringify(refusals)}`);
    assert.equal(refusals[4], refusals[1], "a write is refused for the reason a read of the same file is");
  });
});
