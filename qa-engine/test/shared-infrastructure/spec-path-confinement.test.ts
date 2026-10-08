/* The confined reader is the one way the orchestrator reads, or even probes, a path an agent reported. The agent writes the suite's spec files and names them in its verdict, so a name can be anything it chose, a symlink or a named pipe it planted included. Every fixture lives under os.tmpdir(), with real symlinks and real pipes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfinedPathError,
  MAX_SPEC_SOURCE_BYTES,
  readConfinedSpecBytes,
  readConfinedSpecFile,
  readFailureReason,
  resolveConfinedSpecFile,
  type SpecRoot,
} from "../../src/shared-infrastructure/spec-path-confinement.ts";

/* <tmp>/mirror/e2e/{a.spec.ts, flows/b.spec.ts} is the suite; <tmp>/outside/secret.txt is what no read may reach. `tmp` is deliberately not a real path (os.tmpdir() sits behind a symlink on macOS), so a reader that compares unresolved paths fails here. */
interface Fixture {
  tmp: string;
  mirror: string;
  specDir: string;
  root: SpecRoot;
}

function withFixture(run: (f: Fixture) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), "qa-spec-confinement-"));
  try {
    const mirror = join(tmp, "mirror");
    const specDir = join(mirror, "e2e");
    mkdirSync(join(specDir, "flows"), { recursive: true });
    mkdirSync(join(tmp, "outside"));
    writeFileSync(join(specDir, "a.spec.ts"), "// spec a\n");
    writeFileSync(join(specDir, "flows", "b.spec.ts"), "// spec b\n");
    writeFileSync(join(tmp, "outside", "secret.txt"), "TOP SECRET");
    run({ tmp, mirror, specDir, root: { mirrorDir: mirror, specDir } });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* The rejection a read raises: it must be the typed error, and the probe must agree. */
function rejection(root: SpecRoot, reported: string): ConfinedPathError {
  assert.equal(resolveConfinedSpecFile(root, reported), undefined, `probing ${JSON.stringify(reported)} resolved a file`);
  try {
    readConfinedSpecBytes(root, reported);
  } catch (err) {
    assert.ok(err instanceof ConfinedPathError, `reading ${JSON.stringify(reported)} threw ${String(err)}, not a ConfinedPathError`);
    return err;
  }
  return assert.fail(`${JSON.stringify(reported)} was read`);
}

/* The named-pipe cases need mkfifo; where it is missing they skip, and say so. */
function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-spec-confinement-fifo-probe-"));
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

function canCountDescriptors(): boolean {
  try {
    return readdirSync("/dev/fd").length > 0;
  } catch {
    return false;
  }
}

const NO_DESCRIPTOR_LISTING = canCountDescriptors() ? false : "/dev/fd is not available on this platform, so descriptor leaks cannot be counted";

/* ── what a confined reader accepts ───────────────────────────────────────────────────────────── */

test("a regular file inside the spec directory resolves to its real path", () => {
  withFixture((f) => {
    assert.equal(resolveConfinedSpecFile(f.root, "a.spec.ts"), realpathSync(join(f.specDir, "a.spec.ts")));
    assert.equal(resolveConfinedSpecFile(f.root, "flows/b.spec.ts"), realpathSync(join(f.specDir, "flows", "b.spec.ts")));
  });
});

test("backslashes, doubled separators and a leading dot segment name the same file", () => {
  withFixture((f) => {
    const expected = realpathSync(join(f.specDir, "flows", "b.spec.ts"));
    for (const spelling of ["flows\\b.spec.ts", "flows//b.spec.ts", "./flows/b.spec.ts", "flows/./b.spec.ts"]) {
      assert.equal(resolveConfinedSpecFile(f.root, spelling), expected, spelling);
    }
  });
});

test("every backslash of a path is a separator, not only the first", () => {
  withFixture((f) => {
    mkdirSync(join(f.specDir, "flows", "deep"));
    writeFileSync(join(f.specDir, "flows", "deep", "c.spec.ts"), "// spec c\n");
    assert.equal(resolveConfinedSpecFile(f.root, "flows\\deep\\c.spec.ts"), realpathSync(join(f.specDir, "flows", "deep", "c.spec.ts")));
    assert.equal(readConfinedSpecFile(f.root, "flows\\deep/c.spec.ts"), "// spec c\n");
  });
});

test("a name with two dots inside it is not a parent segment", () => {
  withFixture((f) => {
    mkdirSync(join(f.specDir, "..d"));
    writeFileSync(join(f.specDir, "a..b.spec.ts"), "// dots\n");
    writeFileSync(join(f.specDir, "..d", "c.spec.ts"), "// in a dotted directory\n");
    assert.equal(resolveConfinedSpecFile(f.root, "a..b.spec.ts"), realpathSync(join(f.specDir, "a..b.spec.ts")));
    assert.equal(resolveConfinedSpecFile(f.root, "..d/c.spec.ts"), realpathSync(join(f.specDir, "..d", "c.spec.ts")));
  });
});

test("a symlink to another file inside the spec directory resolves to the target's real path", () => {
  withFixture((f) => {
    symlinkSync("a.spec.ts", join(f.specDir, "alias.spec.ts"));
    assert.equal(resolveConfinedSpecFile(f.root, "alias.spec.ts"), realpathSync(join(f.specDir, "a.spec.ts")));
    assert.equal(readConfinedSpecFile(f.root, "alias.spec.ts"), "// spec a\n");
  });
});

test("a code run's root, where the spec directory is the mirror itself, confines the same way", () => {
  withFixture((f) => {
    writeFileSync(join(f.mirror, "unit.test.ts"), "// unit\n");
    const root = { mirrorDir: f.mirror, specDir: f.mirror };
    assert.equal(resolveConfinedSpecFile(root, "unit.test.ts"), realpathSync(join(f.mirror, "unit.test.ts")));
    assert.equal(resolveConfinedSpecFile(root, "e2e/a.spec.ts"), realpathSync(join(f.specDir, "a.spec.ts")));
    rejection(root, "../outside/secret.txt");
  });
});

test("a mirror and a spec directory reached through a symlinked path are anchored on their real locations", () => {
  withFixture((f) => {
    const viaLink = join(f.tmp, "mirror-link");
    symlinkSync(f.mirror, viaLink);
    const expected = realpathSync(join(f.specDir, "a.spec.ts"));
    assert.equal(resolveConfinedSpecFile({ mirrorDir: viaLink, specDir: f.specDir }, "a.spec.ts"), expected, "the mirror is the symlinked path");
    assert.equal(resolveConfinedSpecFile({ mirrorDir: f.mirror, specDir: join(viaLink, "e2e") }, "a.spec.ts"), expected, "the spec directory is below the symlinked path");
  });
});

test("a spec directory given with a trailing separator is the same directory", () => {
  withFixture((f) => {
    assert.equal(resolveConfinedSpecFile({ mirrorDir: f.mirror, specDir: `${f.specDir}/` }, "a.spec.ts"), realpathSync(join(f.specDir, "a.spec.ts")));
  });
});

/* ── what it rejects ─────────────────────────────────────────────────────────────────────────── */

interface RejectedCase {
  name: string;
  /* Builds what the case needs on top of the base fixture, and returns the root and the reported path to try. */
  arrange: (f: Fixture) => { root: SpecRoot; reported: string };
}

const outsideFile = (f: Fixture): string => join(f.tmp, "outside", "secret.txt");

const REJECTED: RejectedCase[] = [
  { name: "an empty path", arrange: (f) => ({ root: f.root, reported: "" }) },
  { name: "an absolute path that names a file inside the spec directory", arrange: (f) => ({ root: f.root, reported: join(f.specDir, "a.spec.ts") }) },
  { name: "a slash-led path that a join would place inside the spec directory", arrange: (f) => ({ root: f.root, reported: "/a.spec.ts" }) },
  { name: "a backslash-led path, which is absolute once the separators are normalized", arrange: (f) => ({ root: f.root, reported: "\\a.spec.ts" }) },
  { name: "a parent segment that would stay inside the spec directory", arrange: (f) => ({ root: f.root, reported: "flows/../a.spec.ts" }) },
  { name: "a parent segment that re-enters the spec directory by its own name", arrange: (f) => ({ root: f.root, reported: "../e2e/a.spec.ts" }) },
  { name: "a parent segment spelled with backslashes", arrange: (f) => ({ root: f.root, reported: "flows\\..\\a.spec.ts" }) },
  { name: "parent segments that leave the spec directory", arrange: (f) => ({ root: f.root, reported: "../../outside/secret.txt" }) },
  { name: "parent segments that leave it, spelled with backslashes", arrange: (f) => ({ root: f.root, reported: "..\\..\\outside\\secret.txt" }) },
  {
    name: "a symlink that points at a file outside the spec directory",
    arrange: (f) => {
      symlinkSync("../../outside/secret.txt", join(f.specDir, "leak.spec.ts"));
      return { root: f.root, reported: "leak.spec.ts" };
    },
  },
  {
    name: "a symlink to an absolute path outside the spec directory",
    arrange: (f) => {
      symlinkSync(outsideFile(f), join(f.specDir, "abs-leak.spec.ts"));
      return { root: f.root, reported: "abs-leak.spec.ts" };
    },
  },
  {
    name: "a symlinked directory inside the spec directory that points outside it",
    arrange: (f) => {
      symlinkSync(join(f.tmp, "outside"), join(f.specDir, "hop"));
      return { root: f.root, reported: "hop/secret.txt" };
    },
  },
  {
    name: "a symlink into a sibling directory whose name starts with the spec directory's name",
    arrange: (f) => {
      mkdirSync(join(f.mirror, "e2e-evil"));
      writeFileSync(join(f.mirror, "e2e-evil", "x.spec.ts"), "// planted\n");
      symlinkSync(join(f.mirror, "e2e-evil"), join(f.specDir, "hop"));
      return { root: f.root, reported: "hop/x.spec.ts" };
    },
  },
  {
    name: "a symlink loop",
    arrange: (f) => {
      symlinkSync("loop.spec.ts", join(f.specDir, "loop.spec.ts"));
      return { root: f.root, reported: "loop.spec.ts" };
    },
  },
  { name: "a file that does not exist", arrange: (f) => ({ root: f.root, reported: "missing.spec.ts" }) },
  { name: "a path that goes through a regular file", arrange: (f) => ({ root: f.root, reported: "a.spec.ts/inner.spec.ts" }) },
  { name: "a directory", arrange: (f) => ({ root: f.root, reported: "flows" }) },
  { name: "the spec directory itself", arrange: (f) => ({ root: f.root, reported: "." }) },
  { name: "a path with a NUL byte", arrange: (f) => ({ root: f.root, reported: "a.spec.ts\0" }) },
  {
    name: "a spec directory that is a symlink to a directory inside the mirror",
    arrange: (f) => {
      symlinkSync(f.specDir, join(f.mirror, "e2e-link"));
      return { root: { mirrorDir: f.mirror, specDir: join(f.mirror, "e2e-link") }, reported: "a.spec.ts" };
    },
  },
  {
    name: "a spec directory that is a symlink to a directory outside the mirror",
    arrange: (f) => {
      symlinkSync(join(f.tmp, "outside"), join(f.mirror, "e2e-out"));
      return { root: { mirrorDir: f.mirror, specDir: join(f.mirror, "e2e-out") }, reported: "secret.txt" };
    },
  },
  {
    name: "a spec directory that is a symlink, written with a trailing separator",
    arrange: (f) => {
      symlinkSync(f.specDir, join(f.mirror, "e2e-link"));
      return { root: { mirrorDir: f.mirror, specDir: `${join(f.mirror, "e2e-link")}/` }, reported: "a.spec.ts" };
    },
  },
  {
    name: "a spec directory whose real path leaves the mirror through a symlinked parent",
    arrange: (f) => {
      mkdirSync(join(f.tmp, "elsewhere", "e2e"), { recursive: true });
      writeFileSync(join(f.tmp, "elsewhere", "e2e", "a.spec.ts"), "// planted\n");
      symlinkSync(join(f.tmp, "elsewhere"), join(f.mirror, "hop"));
      return { root: { mirrorDir: f.mirror, specDir: join(f.mirror, "hop", "e2e") }, reported: "a.spec.ts" };
    },
  },
  { name: "a spec directory outside the mirror", arrange: (f) => ({ root: { mirrorDir: f.mirror, specDir: join(f.tmp, "outside") }, reported: "secret.txt" }) },
  { name: "a spec directory that is the parent of the mirror", arrange: (f) => ({ root: { mirrorDir: f.mirror, specDir: f.tmp }, reported: "mirror/e2e/a.spec.ts" }) },
  {
    name: "a spec directory in a sibling of the mirror whose name starts with the mirror's name",
    arrange: (f) => {
      mkdirSync(join(f.tmp, "mirror-evil", "e2e"), { recursive: true });
      writeFileSync(join(f.tmp, "mirror-evil", "e2e", "a.spec.ts"), "// planted\n");
      return { root: { mirrorDir: f.mirror, specDir: join(f.tmp, "mirror-evil", "e2e") }, reported: "a.spec.ts" };
    },
  },
  { name: "a spec directory that does not exist", arrange: (f) => ({ root: { mirrorDir: f.mirror, specDir: join(f.mirror, "no-such-dir") }, reported: "a.spec.ts" }) },
  { name: "a mirror that does not exist", arrange: (f) => ({ root: { mirrorDir: join(f.tmp, "no-such-mirror"), specDir: f.specDir }, reported: "a.spec.ts" }) },
];

for (const rejected of REJECTED) {
  test(`${rejected.name} is rejected by the probe and by the reader, which says which path was reported`, () => {
    withFixture((f) => {
      const { root, reported } = rejected.arrange(f);
      const err = rejection(root, reported);
      assert.equal(err.path, reported, "the error carries the path exactly as it was reported");
      assert.ok(err.message.includes(err.path) && err.message.includes(err.reason), "the message names the path and the reason");
    });
  });
}

/* A named pipe is only refused correctly if it is never opened: opening one for reading waits for a writer that never comes, so a reader that opens it before judging it hangs these cases instead of failing them. */
test("a named pipe is rejected without being opened, by the probe and by the reader", { skip: NO_NAMED_PIPES }, () => {
  withFixture((f) => {
    execFileSync("mkfifo", [join(f.specDir, "pipe.spec.ts")]);
    execFileSync("mkfifo", [join(f.specDir, "flows", "nested-pipe.spec.ts")]);
    assert.equal(rejection(f.root, "pipe.spec.ts").path, "pipe.spec.ts");
    assert.equal(rejection(f.root, "flows/nested-pipe.spec.ts").path, "flows/nested-pipe.spec.ts");
  });
});

test("a symlink to a named pipe inside the spec directory is rejected without being opened", { skip: NO_NAMED_PIPES }, () => {
  withFixture((f) => {
    execFileSync("mkfifo", [join(f.specDir, "pipe.spec.ts")]);
    symlinkSync("pipe.spec.ts", join(f.specDir, "pipe-alias.spec.ts"));
    rejection(f.root, "pipe-alias.spec.ts");
  });
});

test("every kind of rejection gives a reason of its own, so the operator can tell them apart", () => {
  withFixture((f) => {
    symlinkSync(outsideFile(f), join(f.specDir, "leak.spec.ts"));
    symlinkSync(f.specDir, join(f.mirror, "e2e-link"));
    writeFileSync(join(f.specDir, "over.spec.ts"), "x".repeat(MAX_SPEC_SOURCE_BYTES + 1));
    const reasons = [
      rejection(f.root, "").reason,
      rejection(f.root, "/a.spec.ts").reason,
      rejection(f.root, "flows/../a.spec.ts").reason,
      rejection(f.root, "leak.spec.ts").reason,
      rejection(f.root, "missing.spec.ts").reason,
      rejection(f.root, "flows").reason,
      rejection({ mirrorDir: f.mirror, specDir: join(f.mirror, "e2e-link") }, "a.spec.ts").reason,
      rejection({ mirrorDir: f.mirror, specDir: join(f.tmp, "outside") }, "secret.txt").reason,
      rejection({ mirrorDir: f.mirror, specDir: join(f.mirror, "no-such-dir") }, "a.spec.ts").reason,
    ];
    try {
      readConfinedSpecBytes(f.root, "over.spec.ts");
      assert.fail("an oversized file was read");
    } catch (err) {
      assert.ok(err instanceof ConfinedPathError);
      reasons.push(err.reason);
    }
    assert.equal(new Set(reasons).size, reasons.length, `two kinds of rejection share a reason: ${JSON.stringify(reasons)}`);
    for (const reason of reasons) assert.notEqual(reason, "", "a reason is never empty");
  });
});

test("a ConfinedPathError is an Error that prints under a name of its own", () => {
  const err = new ConfinedPathError("flows/x.spec.ts", "some reason");
  assert.ok(err instanceof Error);
  assert.equal(err.path, "flows/x.spec.ts");
  assert.equal(err.reason, "some reason");
  assert.ok(err.message.includes("flows/x.spec.ts") && err.message.includes("some reason"));
  assert.notEqual(err.name, new Error().name);
});

/* ── what it reads ───────────────────────────────────────────────────────────────────────────── */

test("a confined file is read byte for byte, and decoded as UTF-8 by the string reader", () => {
  withFixture((f) => {
    const text = "// ñandú 日本語 ✓\ntest('x', () => {});\n";
    writeFileSync(join(f.specDir, "utf8.spec.ts"), text);
    assert.deepEqual(readConfinedSpecBytes(f.root, "utf8.spec.ts"), Buffer.from(text, "utf8"));
    assert.equal(readConfinedSpecFile(f.root, "utf8.spec.ts"), text);
    assert.equal(readConfinedSpecFile(f.root, "flows/b.spec.ts"), "// spec b\n");
  });
});

test("an empty file reads as no bytes and an empty string", () => {
  withFixture((f) => {
    writeFileSync(join(f.specDir, "empty.spec.ts"), "");
    assert.equal(readConfinedSpecBytes(f.root, "empty.spec.ts").length, 0);
    assert.equal(readConfinedSpecFile(f.root, "empty.spec.ts"), "");
  });
});

test("a file of exactly the size cap is read and one byte more is rejected, by both readers", () => {
  withFixture((f) => {
    writeFileSync(join(f.specDir, "cap.spec.ts"), "x".repeat(MAX_SPEC_SOURCE_BYTES));
    writeFileSync(join(f.specDir, "over.spec.ts"), "x".repeat(MAX_SPEC_SOURCE_BYTES + 1));
    assert.equal(readConfinedSpecBytes(f.root, "cap.spec.ts").length, MAX_SPEC_SOURCE_BYTES);
    assert.equal(readConfinedSpecFile(f.root, "cap.spec.ts").length, MAX_SPEC_SOURCE_BYTES);
    const tooLarge = (err: unknown): boolean => err instanceof ConfinedPathError && err.path === "over.spec.ts";
    assert.throws(() => readConfinedSpecBytes(f.root, "over.spec.ts"), tooLarge);
    assert.throws(() => readConfinedSpecFile(f.root, "over.spec.ts"), tooLarge);
  });
});

test("the probe never judges a file's size, because it never opens the file", () => {
  withFixture((f) => {
    writeFileSync(join(f.specDir, "over.spec.ts"), "x".repeat(MAX_SPEC_SOURCE_BYTES + 1));
    assert.equal(resolveConfinedSpecFile(f.root, "over.spec.ts"), realpathSync(join(f.specDir, "over.spec.ts")));
  });
});

test("an explicit cap replaces the default one, whether lower or higher", () => {
  withFixture((f) => {
    writeFileSync(join(f.specDir, "five.spec.ts"), "12345");
    writeFileSync(join(f.specDir, "over.spec.ts"), "x".repeat(MAX_SPEC_SOURCE_BYTES + 1));
    assert.equal(readConfinedSpecBytes(f.root, "five.spec.ts", 5).toString("utf8"), "12345");
    assert.equal(readConfinedSpecFile(f.root, "five.spec.ts", 5), "12345");
    assert.throws(() => readConfinedSpecBytes(f.root, "five.spec.ts", 4), ConfinedPathError);
    assert.throws(() => readConfinedSpecFile(f.root, "five.spec.ts", 4), ConfinedPathError);
    assert.equal(readConfinedSpecBytes(f.root, "over.spec.ts", MAX_SPEC_SOURCE_BYTES + 1).length, MAX_SPEC_SOURCE_BYTES + 1);
  });
});

test("a read releases its descriptor, whether it returns or rejects", { skip: NO_DESCRIPTOR_LISTING }, () => {
  withFixture((f) => {
    const open = (): number => readdirSync("/dev/fd").length;
    const before = open();
    for (let i = 0; i < 200; i++) {
      readConfinedSpecBytes(f.root, "a.spec.ts");
      assert.throws(() => readConfinedSpecBytes(f.root, "a.spec.ts", 1), ConfinedPathError, "rejected after the file was opened");
    }
    assert.ok(open() - before < 20, `${open() - before} descriptors were left open by 400 reads`);
  });
});

/* ── why a read failed ─────────────────────────────────────────────────────────────────────────── */

/* What a read refused or failed on goes to logs and to validation findings, which an agent reads: it names the file and says why, and quotes nothing the file holds. An error's own message can: a parser's quotes the first characters of what it was given. */
test("a read failure is told by the refusal's own reason or by the code of the call that failed, and never by an error's message", () => {
  assert.equal(readFailureReason(new ConfinedPathError("a.spec.ts", "short read")), "short read");
  assert.equal(readFailureReason(new ConfinedPathError("b.spec.ts", "the file is larger than 5 bytes")), "the file is larger than 5 bytes");
  assert.equal(readFailureReason(Object.assign(new Error("EACCES: permission denied, open '/mirror/e2e/flows/a.spec.ts'"), { code: "EACCES" })), "EACCES");
  assert.equal(readFailureReason(Object.assign(new Error("EISDIR: illegal operation on a directory, read"), { code: "EISDIR" })), "EISDIR");
});

test("a failure that has no code is told by one fixed reason, which is neither undefined nor any part of its message", () => {
  const fixed = readFailureReason(new SyntaxError('Unexpected token \'S\', "SECRETv1 hunter2" is not valid JSON'));

  assert.notEqual(fixed, "");
  assert.doesNotMatch(fixed, /undefined|SECRETv1|hunter2/);
  const odd: unknown[] = [new RangeError("another message"), new TypeError("x"), "a string that was thrown", 42, null, undefined, {}, { code: 5 }, { code: "" }, Object.assign(new Error("no code"), { code: undefined })];
  for (const failure of odd) {
    assert.equal(readFailureReason(failure), fixed, `a failure of ${String(failure)} is told in the same words`);
  }
});
