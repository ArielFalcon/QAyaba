/* The orchestrator also walks the files of a repository's mirror for something other than the suite: the topology resolvers read the sources of every repository of a system, and the staging of a service's context lists the service's files. A mirror is a directory the agent can write into, and a repository's own tree can hold links that were committed, so the walk lists a directory entry by entry and no more than a cap of them, takes a file only when it is a regular file by what it is itself (a link or a named pipe named like a source is not one, and nothing is opened to find out), enters a directory only when it is one by what it is itself (a link to a directory is never entered, so a link back up cannot make the walk run away), and visits the entries in the order of their names so that what it finds does not depend on the filesystem. Every fixture lives under os.tmpdir(), with real links, real pipes and real modes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_WALK_LIMITS, walkRepoFiles } from "../../src/shared-infrastructure/spec-path-confinement.ts";
import { withoutWaitingOnNamedPipe } from "../support/named-pipe-watch.ts";

/* <tmp>/repo is the mirror; <tmp>/outside is what no walk may enter. */
interface Fixture {
  tmp: string;
  repo: string;
  outside: string;
}

function makeFixture(): { fixture: Fixture; remove: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "qa-repo-walk-"));
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  mkdirSync(join(tmp, "outside"));
  writeFileSync(join(tmp, "outside", "Elsewhere.java"), "// outside\n");
  return { fixture: { tmp, repo, outside: join(tmp, "outside") }, remove: () => rmSync(tmp, { recursive: true, force: true }) };
}

function withFixture(run: (f: Fixture) => void): void {
  const { fixture, remove } = makeFixture();
  try {
    run(fixture);
  } finally {
    remove();
  }
}

async function withFixtureAsync(run: (f: Fixture) => Promise<void>): Promise<void> {
  const { fixture, remove } = makeFixture();
  try {
    await run(fixture);
  } finally {
    remove();
  }
}

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-repo-walk-fifo-probe-"));
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
const NO_MODE_RESTRICTIONS = process.platform === "win32" || process.getuid?.() === 0 ? "the account that runs the tests is not bound by directory modes, so the cases that rely on them are not exercised" : false;

function canCountDescriptors(): boolean {
  try {
    return readdirSync("/dev/fd").length > 0;
  } catch {
    return false;
  }
}

const NO_DESCRIPTOR_LISTING = canCountDescriptors() ? false : "/dev/fd is not available on this platform, so descriptor leaks cannot be counted";

const JAVA = (name: string): boolean => name.endsWith(".java");
const VENDOR = new Set(["node_modules", ".git", "dist"]);
const touch = (path: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "// x\n");
};

test("the accepted files are listed by their path below the root, '/'-separated, entry by entry in the order of the names and whatever order they were made in", () => {
  withFixture((f) => {
    for (const rel of ["z.java", "sub/deep/c.java", "a.java", "sub/b.java", "other/x.java", "sub/a.java", "notes.txt"]) touch(join(f.repo, rel));

    const walk = walkRepoFiles(f.repo, JAVA, VENDOR);

    assert.deepEqual(walk.files, ["a.java", "other/x.java", "sub/a.java", "sub/b.java", "sub/deep/c.java", "z.java"]);
    assert.deepEqual([walk.cut, walk.unlisted, walk.odd, walk.refused], [false, 0, 0, undefined]);
  });
});

test("the predicate is given a file's name and its path below the root, and is asked about files only", () => {
  withFixture((f) => {
    for (const rel of ["a.java", "sub/b.java", "sub/c.java"]) touch(join(f.repo, rel));
    mkdirSync(join(f.repo, "dir.java"));
    const asked: Array<[string, string]> = [];

    const walk = walkRepoFiles(f.repo, (name, rel) => { asked.push([name, rel]); return rel === "sub/b.java"; }, VENDOR);

    assert.deepEqual(walk.files, ["sub/b.java"]);
    assert.deepEqual(asked, [["a.java", "a.java"], ["b.java", "sub/b.java"], ["c.java", "sub/c.java"]], "a directory named like a source is walked, not offered to the predicate");
  });
});

test("the directories named to be skipped are not entered, wherever they are, and a file with such a name is a file", () => {
  withFixture((f) => {
    for (const rel of ["a.java", "node_modules/pkg/x.java", "sub/dist/y.java", "sub/.git/z.java", "sub/keep.java"]) touch(join(f.repo, rel));
    writeFileSync(join(f.repo, "dist"), "a file called dist");

    assert.deepEqual(walkRepoFiles(f.repo, JAVA, VENDOR).files, ["a.java", "sub/keep.java"]);
    assert.deepEqual(walkRepoFiles(f.repo, () => true, VENDOR).files, ["a.java", "dist", "sub/keep.java"]);
  });
});

test("a link is never followed or listed, whatever it points at: not a link to a directory outside, inside or back up, and not a link to a file", () => {
  withFixture((f) => {
    touch(join(f.repo, "real", "Own.java"));
    symlinkSync(f.outside, join(f.repo, "to-outside"));
    symlinkSync(join(f.repo, "real"), join(f.repo, "to-inside"));
    symlinkSync(f.repo, join(f.repo, "real", "to-root"));
    symlinkSync(join(f.outside, "Elsewhere.java"), join(f.repo, "Linked.java"));
    symlinkSync(join(f.outside, "no-such-file.java"), join(f.repo, "Dangling.java"));

    const walk = walkRepoFiles(f.repo, JAVA, VENDOR);

    assert.deepEqual(walk.files, ["real/Own.java"]);
    assert.deepEqual([walk.cut, walk.unlisted, walk.odd], [false, 0, 0], "a link is an ordinary thing in a repository: it is left out, and is not counted");
  });
});

test("a named pipe named like a source is not listed, is never opened, and is counted: none belongs in a repository", { skip: NO_NAMED_PIPES }, async () => {
  await withFixtureAsync(async (f) => {
    touch(join(f.repo, "Real.java"));
    execFileSync("mkfifo", [join(f.repo, "Planted.java")]);
    execFileSync("mkfifo", [join(f.repo, "other-name")]);

    const walk = await withoutWaitingOnNamedPipe(join(f.repo, "Planted.java"), () => walkRepoFiles(f.repo, JAVA, VENDOR));

    assert.deepEqual(walk.files, ["Real.java"]);
    assert.equal(walk.odd, 2, "whatever its name, and not only the ones the predicate would take");
  });
});

test("a root that is a link or a file is not walked, and says why; one that is not there has nothing to walk", () => {
  withFixture((f) => {
    touch(join(f.outside, "sub", "Own.java"));
    symlinkSync(f.outside, join(f.tmp, "linked"));
    writeFileSync(join(f.tmp, "plain"), "x");

    const linked = walkRepoFiles(join(f.tmp, "linked"), JAVA, VENDOR);
    const plain = walkRepoFiles(join(f.tmp, "plain"), JAVA, VENDOR);
    const missing = walkRepoFiles(join(f.tmp, "missing"), JAVA, VENDOR);

    assert.deepEqual(linked.files, [], "nothing behind a link");
    assert.ok(linked.refused && plain.refused && linked.refused !== plain.refused, "each says why, in words of its own");
    assert.deepEqual(plain.files, []);
    assert.deepEqual(missing, { files: [], cut: false, unlisted: 0, odd: 0 });
  });
});

test("no more entries than the cap are looked at in all the directories together: exactly the cap is walked whole, one more is cut", () => {
  withFixture((f) => {
    for (const rel of ["a.java", "b.java", "sub/c.java", "sub/d.java"]) touch(join(f.repo, rel));

    const whole = walkRepoFiles(f.repo, JAVA, VENDOR, { maxEntries: 5, maxFiles: 100 });
    const cut = walkRepoFiles(f.repo, JAVA, VENDOR, { maxEntries: 4, maxFiles: 100 });

    assert.equal(whole.files.length, 4, "three entries at the root (two files and sub) and two below it are five");
    assert.equal(whole.cut, false);
    assert.equal(cut.cut, true);
    assert.deepEqual(cut.files, ["a.java", "b.java", "sub/c.java"], "the entry that was not looked at is not found");
  });
});

test("no more files than the cap are collected: exactly the cap is every file, one more is cut", () => {
  withFixture((f) => {
    for (const rel of ["a.java", "b.java", "sub/c.java", "z.java"]) touch(join(f.repo, rel));

    const whole = walkRepoFiles(f.repo, JAVA, VENDOR, { maxEntries: 100, maxFiles: 4 });
    const cut = walkRepoFiles(f.repo, JAVA, VENDOR, { maxEntries: 100, maxFiles: 3 });

    assert.deepEqual([whole.files.length, whole.cut], [4, false]);
    assert.deepEqual(cut.files, ["a.java", "b.java", "sub/c.java"], "the files that come first are the ones kept");
    assert.equal(cut.cut, true);
  });
});

test("a directory that cannot be listed is counted and does not stop the walk of the others", { skip: NO_MODE_RESTRICTIONS }, () => {
  withFixture((f) => {
    touch(join(f.repo, "open", "a.java"));
    touch(join(f.repo, "locked", "hidden.java"));
    chmodSync(join(f.repo, "locked"), 0o000);
    try {
      const walk = walkRepoFiles(f.repo, JAVA, VENDOR);

      assert.deepEqual(walk.files, ["open/a.java"]);
      assert.equal(walk.unlisted, 1);
    } finally {
      chmodSync(join(f.repo, "locked"), 0o755);
    }
  });
});

test("a walk releases the handle of every directory it opened, whether it walked it whole, cut it or could not list it", { skip: NO_DESCRIPTOR_LISTING }, () => {
  withFixture((f) => {
    for (const rel of ["a/b/x.java", "a/b/y.java", "a/z.java"]) touch(join(f.repo, rel));
    const open = (): number => readdirSync("/dev/fd").length;
    const before = open();

    for (let i = 0; i < 200; i++) {
      walkRepoFiles(f.repo, JAVA, VENDOR);
      walkRepoFiles(f.repo, JAVA, VENDOR, { maxEntries: 3, maxFiles: 100 });
      walkRepoFiles(join(f.repo, "missing"), JAVA, VENDOR);
    }

    assert.ok(open() - before < 20, `${open() - before} descriptors were left open by 600 walks`);
  });
});

test("the limits a walk is held to by default are far beyond any repository", () => {
  assert.ok(REPO_WALK_LIMITS.maxEntries >= 200_000 && REPO_WALK_LIMITS.maxEntries <= 5_000_000, `${REPO_WALK_LIMITS.maxEntries} entries`);
  assert.ok(REPO_WALK_LIMITS.maxFiles >= 50_000 && REPO_WALK_LIMITS.maxFiles <= 1_000_000, `${REPO_WALK_LIMITS.maxFiles} files`);
  assert.ok(REPO_WALK_LIMITS.maxFiles <= REPO_WALK_LIMITS.maxEntries);
});
