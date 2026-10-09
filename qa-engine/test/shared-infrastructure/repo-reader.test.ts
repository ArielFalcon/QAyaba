/* What a topology resolver reads of a repository's mirror is read through one reader: the walk of the files it takes (see spec-path-confinement) and a strict, capped read of each, so that a link, a named pipe or a file of any size in a directory the agent writes into costs the reader nothing but a count. What it could not use is said once, for the repository, by how many and why, and names no file and quotes no byte of one: a file's name is the agent's to choose, and a parser's message quotes what it parsed. Every case runs against real files, links and pipes under os.tmpdir(); the pipe cases run under the watch of test/support/named-pipe-watch.ts. */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_READER_LIMITS, RepoReader } from "../../src/shared-infrastructure/repo-reader.ts";
import { REPO_WALK_LIMITS } from "../../src/shared-infrastructure/spec-path-confinement.ts";
import { withoutWaitingOnNamedPipe } from "../support/named-pipe-watch.ts";

const SECRET_MARK = "SECRETv1-hunter2";
const VENDOR = new Set(["node_modules"]);
const JAVA = (name: string): boolean => name.endsWith(".java");

interface Fixture {
  tmp: string;
  repo: string;
  outside: string;
}

async function withFixture(run: (f: Fixture) => Promise<void> | void): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-repo-reader-"));
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  mkdirSync(join(tmp, "outside"));
  try {
    await run({ tmp, repo, outside: join(tmp, "outside") });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* What the reader says on the way, which goes to logs. */
function capturing<T>(run: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    return { value: run(), warnings };
  } finally {
    warn.mock.restore();
  }
}

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-repo-reader-fifo-probe-"));
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

test("the files are the walk's, and a file that is listed is read as text", async () => {
  await withFixture((f) => {
    mkdirSync(join(f.repo, "sub"));
    writeFileSync(join(f.repo, "b.java"), "class B {}\n");
    writeFileSync(join(f.repo, "sub", "a.java"), "class A {}\n");
    writeFileSync(join(f.repo, "notes.txt"), "not a source");
    const reader = new RepoReader(f.repo);

    const files = reader.files(JAVA, VENDOR);

    assert.deepEqual(files, ["b.java", "sub/a.java"]);
    assert.deepEqual(files.map((file) => reader.listedText(file, 1024)), ["class B {}\n", "class A {}\n"]);
    assert.deepEqual(capturing(() => reader.warn("org/repo")).warnings, [], "nothing was left out, so nothing is said");
  });
});

test("a file that is a link, a directory or over the cap is not read and is counted by why, in one line for the repository that names no file and quotes none", async () => {
  await withFixture((f) => {
    writeFileSync(join(f.outside, "secret.txt"), `${SECRET_MARK}=hunter2`);
    writeFileSync(join(f.repo, "fine.java"), "class Fine {}\n");
    symlinkSync(join(f.outside, "secret.txt"), join(f.repo, "linked.java"));
    symlinkSync(join(f.outside, "secret.txt"), join(f.repo, "linked-two.java"));
    mkdirSync(join(f.repo, "dir.java"));
    writeFileSync(join(f.repo, "big.java"), "x".repeat(2000));
    const reader = new RepoReader(f.repo);

    const read = (rel: string): string | undefined => reader.listedText(rel, 1000);
    const values = ["fine.java", "linked.java", "linked-two.java", "dir.java", "big.java"].map(read);
    const { warnings } = capturing(() => reader.warn("org/repo"));

    assert.deepEqual(values, ["class Fine {}\n", undefined, undefined, undefined, undefined]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /org\/repo/, "the repository is named");
    assert.ok(/\b4 file/.test(warnings[0]!), `how many: ${warnings[0]}`);
    assert.deepEqual([...warnings[0]!.matchAll(/×(\d+)/g)].map((m) => Number(m[1])).sort(), [1, 3], "and by why: the two links and the directory are refused for one reason, the big file for another");
    assert.ok(!/linked|dir\.java|big\.java|fine\.java|secret/.test(warnings[0]!), "no file is named");
    assert.ok(!warnings[0]!.includes(SECRET_MARK) && !warnings[0]!.includes("hunter2"), "nothing of the file behind a link is quoted");
  });
});

test("a named pipe is not read and not waited on, and is counted", { skip: NO_NAMED_PIPES }, async () => {
  await withFixture(async (f) => {
    execFileSync("mkfifo", [join(f.repo, "Planted.java")]);
    const reader = new RepoReader(f.repo);

    const value = await withoutWaitingOnNamedPipe(join(f.repo, "Planted.java"), () => reader.listedText("Planted.java", 1024));

    assert.equal(value, undefined);
    assert.ok(/\b1 file/.test(capturing(() => reader.warn("org/repo")).warnings[0] ?? ""));
  });
});

test("a file that cannot be read is counted by the code of the failure, not by what the failure says", { skip: NO_MODE_RESTRICTIONS }, async () => {
  await withFixture((f) => {
    writeFileSync(join(f.repo, "locked.java"), "class Locked {}\n");
    chmodSync(join(f.repo, "locked.java"), 0o000);
    const reader = new RepoReader(f.repo);
    try {
      assert.equal(reader.listedText("locked.java", 1024), undefined);
      const { warnings } = capturing(() => reader.warn("org/repo"));

      assert.ok(warnings[0]!.includes("EACCES"), warnings[0]);
      assert.ok(!warnings[0]!.includes("locked.java"), "and no file is named");
    } finally {
      chmodSync(join(f.repo, "locked.java"), 0o644);
    }
  });
});

test("a listed file that is gone when it is read is counted, and a file that is optional and not there is nothing to say", async () => {
  await withFixture((f) => {
    const reader = new RepoReader(f.repo);

    assert.equal(reader.optionalText("api/openapi.yaml", 1024), undefined);
    assert.deepEqual(capturing(() => reader.warn("org/repo")).warnings, [], "an optional file that is not there is not counted");
    assert.equal(reader.listedText("Gone.java", 1024), undefined);
    assert.ok(/\b1 file/.test(capturing(() => reader.warn("org/repo")).warnings[0] ?? ""), "a listed file that is not there is");
  });
});

test("an optional file is read like any other, and one that is refused is counted", async () => {
  await withFixture((f) => {
    mkdirSync(join(f.repo, "api"));
    writeFileSync(join(f.repo, "api", "openapi.yaml"), "openapi: 3.0.3\n");
    mkdirSync(join(f.repo, "other"));
    symlinkSync(join(f.repo, "api", "openapi.yaml"), join(f.repo, "other", "openapi.yaml"));
    const reader = new RepoReader(f.repo);

    assert.equal(reader.optionalText("api/openapi.yaml", 1024), "openapi: 3.0.3\n");
    assert.equal(reader.optionalText("other/openapi.yaml", 1024), undefined);
    assert.ok(/\b1 file/.test(capturing(() => reader.warn("org/repo")).warnings[0] ?? ""));
  });
});

test("what the walk could not do is said with what the reads could not: a cut, directories that could not be listed, and a root that is refused", async () => {
  await withFixture((f) => {
    for (const name of ["a", "b", "c", "d"]) writeFileSync(join(f.repo, `${name}.java`), "class X {}\n");
    const cut = new RepoReader(f.repo, { maxEntries: 3, maxFiles: 100 });
    cut.files(JAVA, VENDOR);
    const refused = new RepoReader(join(f.tmp, "repo-link"));
    symlinkSync(f.repo, join(f.tmp, "repo-link"));
    refused.files(JAVA, VENDOR);

    const cutWarnings = capturing(() => cut.warn("org/repo")).warnings;
    const refusedWarnings = capturing(() => refused.warn("org/repo")).warnings;

    assert.equal(cutWarnings.length, 1);
    assert.ok(/\b3 entries\b/.test(cutWarnings[0]!), `the walk was cut at its cap: ${cutWarnings[0]}`);
    assert.equal(refusedWarnings.length, 1);
    assert.ok(refusedWarnings[0]!.includes("org/repo"), refusedWarnings[0]);
  });
});

test("a named pipe among the files is counted without a name, whatever it is called, and is never opened", { skip: NO_NAMED_PIPES }, async () => {
  await withFixture(async (f) => {
    writeFileSync(join(f.repo, "Real.java"), "class Real {}\n");
    execFileSync("mkfifo", [join(f.repo, "Planted.java")]);
    execFileSync("mkfifo", [join(f.repo, "secret-pipe-name")]);
    const reader = new RepoReader(f.repo);

    const files = await withoutWaitingOnNamedPipe(join(f.repo, "Planted.java"), () => reader.files(JAVA, VENDOR));
    const { warnings } = capturing(() => reader.warn("org/repo"));

    assert.deepEqual(files, ["Real.java"]);
    assert.equal(warnings.length, 1);
    assert.ok(/\b2 entries\b/.test(warnings[0]!), warnings[0]);
    assert.ok(!warnings[0]!.includes("Planted") && !warnings[0]!.includes("secret-pipe-name"), "and no name");
  });
});

test("directories that could not be listed are counted without a name", { skip: NO_MODE_RESTRICTIONS }, async () => {
  await withFixture((f) => {
    mkdirSync(join(f.repo, "locked-secret-name"));
    chmodSync(join(f.repo, "locked-secret-name"), 0o000);
    const reader = new RepoReader(f.repo);
    try {
      reader.files(JAVA, VENDOR);
      const { warnings } = capturing(() => reader.warn("org/repo"));

      assert.equal(warnings.length, 1);
      assert.ok(/\b1 director/.test(warnings[0]!), warnings[0]);
      assert.ok(!warnings[0]!.includes("locked-secret-name"), "and no name");
    } finally {
      chmodSync(join(f.repo, "locked-secret-name"), 0o755);
    }
  });
});

test("the warning is one line however many files were left out, and it is said once: a second warn has nothing more to say", async () => {
  await withFixture((f) => {
    for (let i = 0; i < 200; i++) symlinkSync(join(f.outside, "nothing"), join(f.repo, `l${i}.java`));
    const reader = new RepoReader(f.repo);
    for (let i = 0; i < 200; i++) reader.listedText(`l${i}.java`, 1024);

    const first = capturing(() => reader.warn("org/repo")).warnings;
    const second = capturing(() => reader.warn("org/repo")).warnings;

    assert.equal(first.length, 1);
    assert.ok(first[0]!.length < 500, "bounded");
    assert.deepEqual(second, [], "what was said is not said again");
  });
});

/* ── the total a repository may cost ───────────────────────────────────────────────────────────── */

/* A cap on each file says nothing of how many there are: two hundred thousand files of 4 MiB each are as many gigabytes read in the orchestrator's one thread. A repository is read up to a total of bytes. */
const ten = "x".repeat(10);
const withTenFiles = (f: Fixture, names: string[]): void => {
  for (const name of names) writeFileSync(join(f.repo, `${name}.java`), ten);
};

test("a repository is read up to a total of bytes, and the files after that are not read: the file that crosses the total is read, and the rest are counted", async () => {
  await withFixture((f) => {
    withTenFiles(f, ["a", "b", "c", "d", "e"]);
    const reader = new RepoReader(f.repo, { maxEntries: 100, maxFiles: 100, maxTotalBytes: 25 });

    const values = ["a", "b", "c", "d", "e"].map((name) => reader.listedText(`${name}.java`, 1024));
    const { warnings } = capturing(() => reader.warn("org/repo"));

    assert.deepEqual(values, [ten, ten, ten, undefined, undefined], "30 bytes are read to pass 25, and no more");
    assert.equal(warnings.length, 1, "said once for the repository");
    assert.match(warnings[0]!, /org\/repo/);
    assert.ok(/\b2 file/.test(warnings[0]!), `how many were left out: ${warnings[0]}`);
    assert.ok(/total/.test(warnings[0]!), `and that it was the total: ${warnings[0]}`);
    assert.ok(!/\ba\.java|b\.java|e\.java/.test(warnings[0]!), "no file is named");
  });
});

test("a total of exactly the bytes read leaves the next file unread, and one byte more reads it", async () => {
  await withFixture((f) => {
    withTenFiles(f, ["a", "b", "c", "d"]);
    const at = new RepoReader(f.repo, { maxEntries: 100, maxFiles: 100, maxTotalBytes: 30 });
    const past = new RepoReader(f.repo, { maxEntries: 100, maxFiles: 100, maxTotalBytes: 31 });

    const atValues = ["a", "b", "c", "d"].map((name) => at.listedText(`${name}.java`, 1024));
    const pastValues = ["a", "b", "c", "d"].map((name) => past.listedText(`${name}.java`, 1024));

    assert.deepEqual(atValues, [ten, ten, ten, undefined], "30 bytes have been read: that is the total");
    assert.deepEqual(pastValues, [ten, ten, ten, ten], "30 of 31 have: one more file is read");
    assert.deepEqual(capturing(() => past.warn("org/repo")).warnings, []);
  });
});

test("an optional file counts against the total like any other, and is counted when it is not read for it", async () => {
  await withFixture((f) => {
    withTenFiles(f, ["a", "b"]);
    writeFileSync(join(f.repo, "openapi.yaml"), "openapi: 3\n");
    const reader = new RepoReader(f.repo, { maxEntries: 100, maxFiles: 100, maxTotalBytes: 20 });

    const listed = ["a", "b"].map((name) => reader.listedText(`${name}.java`, 1024));
    const optional = reader.optionalText("openapi.yaml", 1024);
    const { warnings } = capturing(() => reader.warn("org/repo"));

    assert.deepEqual(listed, [ten, ten]);
    assert.equal(optional, undefined, "the total is spent");
    assert.ok(/\b1 file/.test(warnings[0] ?? ""), `and it is counted, which a file that is not there is not: ${JSON.stringify(warnings)}`);
  });
});

test("the total is of one repository: another reader has its own, and what a reader reads is not the other's", async () => {
  await withFixture((f) => {
    withTenFiles(f, ["a", "b"]);
    const first = new RepoReader(f.repo, { maxEntries: 100, maxFiles: 100, maxTotalBytes: 10 });
    const second = new RepoReader(f.repo, { maxEntries: 100, maxFiles: 100, maxTotalBytes: 10 });

    assert.equal(first.listedText("a.java", 1024), ten);
    assert.equal(first.listedText("b.java", 1024), undefined);
    assert.equal(second.listedText("a.java", 1024), ten, "the other repository's reader has read nothing yet");
  });
});

test("a file that is refused, gone or over its cap costs the total nothing: only bytes that were read are counted", async () => {
  await withFixture((f) => {
    withTenFiles(f, ["a", "b"]);
    writeFileSync(join(f.repo, "big.java"), "x".repeat(2000));
    symlinkSync(join(f.outside, "nothing"), join(f.repo, "linked.java"));
    const reader = new RepoReader(f.repo, { maxEntries: 100, maxFiles: 100, maxTotalBytes: 15 });

    const values = [reader.listedText("big.java", 100), reader.listedText("linked.java", 100), reader.listedText("gone.java", 100), reader.listedText("a.java", 1024), reader.listedText("b.java", 1024)];

    assert.deepEqual(values, [undefined, undefined, undefined, ten, ten], "three were refused for their own reasons, and both of the ten-byte files were read");
  });
});

test("the production total is a few hundred megabytes: far beyond any repository's sources and what a reader can be made to read is bounded", () => {
  const MIB = 1024 * 1024;

  assert.ok(REPO_READER_LIMITS.maxTotalBytes >= 64 * MIB && REPO_READER_LIMITS.maxTotalBytes <= 512 * MIB, `${REPO_READER_LIMITS.maxTotalBytes} bytes`);
  assert.equal(REPO_READER_LIMITS.maxEntries, REPO_WALK_LIMITS.maxEntries);
  assert.equal(REPO_READER_LIMITS.maxFiles, REPO_WALK_LIMITS.maxFiles);
});
