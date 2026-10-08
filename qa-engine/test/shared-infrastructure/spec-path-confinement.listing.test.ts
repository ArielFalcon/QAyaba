/* What is listed in a directory the agent writes into is judged the way what is read from it is: by what each entry is itself, never by what a link points at. The walk of the specs says what it could not walk (a link to a directory, a directory it could not list), so that a caller that must not let a spec go unchecked can refuse it; the listing of a directory the orchestrator keeps below the spec directory is walked like an owned file, entry by entry and up to a cap. Every fixture lives under os.tmpdir(), with real links, real pipes and real modes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listOwnedSpecDir, listSpecFiles, scanSpecTree, type SpecRoot } from "../../src/shared-infrastructure/spec-path-confinement.ts";
import { withoutWaitingOnNamedPipe } from "../support/named-pipe-watch.ts";

/* <tmp>/mirror/e2e is the spec directory; <tmp>/outside is what no walk may enter. */
interface Fixture {
  tmp: string;
  mirror: string;
  specDir: string;
  outside: string;
  root: SpecRoot;
}

function withFixture(run: (f: Fixture) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), "qa-spec-listing-"));
  try {
    const mirror = join(tmp, "mirror");
    const specDir = join(mirror, "e2e");
    mkdirSync(specDir, { recursive: true });
    mkdirSync(join(tmp, "outside"));
    writeFileSync(join(tmp, "outside", "elsewhere.spec.ts"), "// outside\n");
    run({ tmp, mirror, specDir, outside: join(tmp, "outside"), root: { mirrorDir: mirror, specDir } });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function withFixtureAsync(run: (f: Fixture) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-spec-listing-"));
  try {
    const mirror = join(tmp, "mirror");
    const specDir = join(mirror, "e2e");
    mkdirSync(specDir, { recursive: true });
    mkdirSync(join(tmp, "outside"));
    await run({ tmp, mirror, specDir, outside: join(tmp, "outside"), root: { mirrorDir: mirror, specDir } });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-spec-listing-fifo-probe-"));
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

/* A directory whose mode is 000 cannot be listed by an account that the mode binds: not by root, and not on a platform without modes. */
const NO_MODE_RESTRICTIONS = process.platform === "win32" || process.getuid?.() === 0 ? "the account that runs the tests is not bound by directory modes, so the cases that rely on them are not exercised" : false;

/* ── the walk of the specs ─────────────────────────────────────────────────────────────────────── */

test("a walk lists every spec below a directory by its path relative to it, and leaves installed packages and dot-directories out", () => {
  withFixture((f) => {
    mkdirSync(join(f.specDir, "flows", "deep"), { recursive: true });
    mkdirSync(join(f.specDir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(f.specDir, ".cache"));
    writeFileSync(join(f.specDir, "a.spec.ts"), "// a\n");
    writeFileSync(join(f.specDir, "flows", "b.spec.ts"), "// b\n");
    writeFileSync(join(f.specDir, "flows", "deep", "c.spec.ts"), "// c\n");
    writeFileSync(join(f.specDir, "flows", "notes.txt"), "not a spec");
    writeFileSync(join(f.specDir, "node_modules", "pkg", "x.spec.ts"), "// installed\n");
    writeFileSync(join(f.specDir, ".cache", "y.spec.ts"), "// hidden\n");

    const tree = scanSpecTree(f.specDir);

    assert.deepEqual([...tree.specs].sort(), ["a.spec.ts", join("flows", "b.spec.ts"), join("flows", "deep", "c.spec.ts")]);
    assert.deepEqual(tree.unwalked, [], "nothing in an ordinary tree is left unwalked");
    assert.deepEqual([...listSpecFiles(f.specDir)].sort(), [...tree.specs].sort(), "the plain listing is the specs of the walk");
  });
});

test("a link to a directory is left unwalked and named, whether it points outside the spec directory, inside it or back up, and nothing behind it is listed", () => {
  withFixture((f) => {
    mkdirSync(join(f.specDir, "flows", "real"), { recursive: true });
    writeFileSync(join(f.specDir, "flows", "real", "own.spec.ts"), "// own\n");
    symlinkSync(f.outside, join(f.specDir, "flows", "to-outside"));
    symlinkSync(join(f.specDir, "flows", "real"), join(f.specDir, "flows", "to-inside"));
    symlinkSync(f.specDir, join(f.specDir, "flows", "to-ancestor"));

    const tree = scanSpecTree(join(f.specDir, "flows"));

    assert.deepEqual(tree.specs, [join("real", "own.spec.ts")], "only the real directory's spec is listed, once");
    assert.deepEqual(tree.unwalked.map((u) => u.path).sort(), ["to-ancestor", "to-inside", "to-outside"]);
    for (const unwalked of tree.unwalked) {
      assert.notEqual(unwalked.reason, "", `${unwalked.path} says why`);
      assert.ok(!unwalked.reason.includes(f.outside) && !unwalked.reason.includes(f.specDir), "a reason does not carry where the link points");
    }
  });
});

test("a link to a directory is named by its path relative to the walked directory, at any depth", () => {
  withFixture((f) => {
    mkdirSync(join(f.specDir, "a", "b"), { recursive: true });
    symlinkSync(f.outside, join(f.specDir, "a", "b", "hop"));

    assert.deepEqual(scanSpecTree(f.specDir).unwalked.map((u) => u.path), [join("a", "b", "hop")]);
  });
});

test("a link named like a spec is a spec to the walk, whatever it points at, and is left for the confined reader to judge", () => {
  withFixture((f) => {
    symlinkSync(join(f.outside, "elsewhere.spec.ts"), join(f.specDir, "linked.spec.ts"));
    symlinkSync(f.outside, join(f.specDir, "dir.spec.ts"));

    const tree = scanSpecTree(f.specDir);

    assert.deepEqual([...tree.specs].sort(), ["dir.spec.ts", "linked.spec.ts"]);
    assert.deepEqual(tree.unwalked, [], "a link with a spec's name is listed, not set aside as a directory");
  });
});

test("a link to a file that is not a spec, or to nothing, is nothing the walk could have walked", () => {
  withFixture((f) => {
    writeFileSync(join(f.outside, "data.json"), "{}");
    symlinkSync(join(f.outside, "data.json"), join(f.specDir, "data.json"));
    symlinkSync(join(f.outside, "no-such-thing"), join(f.specDir, "dangling"));

    assert.deepEqual(scanSpecTree(f.specDir), { specs: [], unwalked: [] });
  });
});

test("a link that cannot be examined is left unwalked, with a reason of its own apart from a link to a directory", () => {
  withFixture((f) => {
    symlinkSync(join(f.specDir, "loop-b"), join(f.specDir, "loop-a"));
    symlinkSync(join(f.specDir, "loop-a"), join(f.specDir, "loop-b"));
    symlinkSync(f.outside, join(f.specDir, "hop"));

    const tree = scanSpecTree(f.specDir);
    const reasons = new Map(tree.unwalked.map((u) => [u.path, u.reason]));

    assert.deepEqual([...reasons.keys()].sort(), ["hop", "loop-a", "loop-b"]);
    assert.notEqual(reasons.get("loop-a"), "", "a link that cannot be examined says why");
    assert.notEqual(reasons.get("loop-a"), reasons.get("hop"), "a link that leads nowhere is not told in the words of a link to a directory");
    assert.equal(reasons.get("loop-a"), reasons.get("loop-b"));
  });
});

test("a directory that cannot be listed is left unwalked and named, and does not stop the walk of the others", { skip: NO_MODE_RESTRICTIONS }, () => {
  withFixture((f) => {
    mkdirSync(join(f.specDir, "open"));
    mkdirSync(join(f.specDir, "locked"));
    writeFileSync(join(f.specDir, "open", "a.spec.ts"), "// a\n");
    writeFileSync(join(f.specDir, "locked", "hidden.spec.ts"), "// hidden\n");
    chmodSync(join(f.specDir, "locked"), 0o000);
    try {
      const tree = scanSpecTree(f.specDir);

      assert.deepEqual(tree.specs, [join("open", "a.spec.ts")]);
      assert.deepEqual(tree.unwalked.map((u) => u.path), ["locked"]);
      assert.notEqual(tree.unwalked[0]!.reason, "");
    } finally {
      chmodSync(join(f.specDir, "locked"), 0o755);
    }
  });
});

test("the directory a walk starts from that cannot be listed is left unwalked as a whole, with an empty path", { skip: NO_MODE_RESTRICTIONS }, () => {
  withFixture((f) => {
    writeFileSync(join(f.specDir, "a.spec.ts"), "// a\n");
    chmodSync(f.specDir, 0o000);
    try {
      const tree = scanSpecTree(f.specDir);

      assert.deepEqual(tree.specs, []);
      assert.deepEqual(tree.unwalked.map((u) => u.path), [""]);
    } finally {
      chmodSync(f.specDir, 0o755);
    }
  });
});

test("a walk that does not start from a real directory finds nothing and leaves nothing unwalked: a missing path, a regular file and a link to a directory", () => {
  withFixture((f) => {
    writeFileSync(join(f.specDir, "plain-file"), "x");
    symlinkSync(f.outside, join(f.specDir, "linked"));

    for (const start of [join(f.specDir, "missing"), join(f.specDir, "plain-file"), join(f.specDir, "linked"), `${join(f.specDir, "linked")}/`]) {
      assert.deepEqual(scanSpecTree(start), { specs: [], unwalked: [] }, start);
    }
  });
});

/* ── the listing of a directory the orchestrator keeps ─────────────────────────────────────────── */

const REL = ".qa/coverage/run-1";

test("an owned directory is listed by the names in it, sorted, however its path is spelled", () => {
  withFixture((f) => {
    mkdirSync(join(f.specDir, ".qa", "coverage", "run-1"), { recursive: true });
    for (const name of ["b.json", "a.json", "note.txt"]) writeFileSync(join(f.specDir, ".qa", "coverage", "run-1", name), "[]");

    for (const spelled of [REL, ".qa\\coverage\\run-1", "./.qa//coverage/run-1", ".qa/coverage/run-1/"]) {
      assert.deepEqual(listOwnedSpecDir(f.root, spelled, 10), { names: ["a.json", "b.json", "note.txt"], truncated: false }, spelled);
    }
  });
});

test("an owned directory that is not there is absent, whether the directory or one above it is missing", () => {
  withFixture((f) => {
    assert.deepEqual(listOwnedSpecDir(f.root, REL, 10), { absent: true });
    mkdirSync(join(f.specDir, ".qa"));
    assert.deepEqual(listOwnedSpecDir(f.root, REL, 10), { absent: true });
  });
});

test("an owned directory reached through a link anywhere is refused and never listed, whatever the link points at", () => {
  withFixture((f) => {
    mkdirSync(join(f.specDir, "inside"));
    writeFileSync(join(f.specDir, "inside", "a.json"), "[]");
    writeFileSync(join(f.outside, "stolen.json"), "[]");
    const cases: Array<[string, () => void]> = [
      ["the directory is a link to a directory outside the mirror", () => { mkdirSync(join(f.specDir, ".qa", "coverage"), { recursive: true }); symlinkSync(f.outside, join(f.specDir, ".qa", "coverage", "run-1")); }],
      ["the directory is a link to a directory inside the spec directory", () => { mkdirSync(join(f.specDir, ".qa", "coverage"), { recursive: true }); symlinkSync(join(f.specDir, "inside"), join(f.specDir, ".qa", "coverage", "run-1")); }],
      ["a directory above it is a link", () => { mkdirSync(join(f.outside, "coverage", "run-1"), { recursive: true }); symlinkSync(f.outside, join(f.specDir, ".qa")); }],
      ["the directory is a link to nothing", () => { mkdirSync(join(f.specDir, ".qa", "coverage"), { recursive: true }); symlinkSync(join(f.outside, "nothing"), join(f.specDir, ".qa", "coverage", "run-1")); }],
    ];
    for (const [what, plant] of cases) {
      plant();
      const listing = listOwnedSpecDir(f.root, REL, 10);
      assert.ok("reason" in listing && listing.reason !== "", what);
      rmSync(join(f.specDir, ".qa"), { recursive: true, force: true });
    }
  });
});

test("an owned directory that is a regular file is refused, and a path with a regular file on the way is too", () => {
  withFixture((f) => {
    mkdirSync(join(f.specDir, ".qa", "coverage"), { recursive: true });
    writeFileSync(join(f.specDir, ".qa", "coverage", "run-1"), "not a directory");
    assert.ok("reason" in listOwnedSpecDir(f.root, REL, 10), "the directory is a regular file");
    rmSync(join(f.specDir, ".qa"), { recursive: true });
    writeFileSync(join(f.specDir, ".qa"), "not a directory");
    assert.ok("reason" in listOwnedSpecDir(f.root, REL, 10), "a directory above it is a regular file");
  });
});

test("an owned directory is refused when the spec directory is a link, leaves the mirror or is missing, and for an empty, absolute or parent-bearing path", () => {
  withFixture((f) => {
    mkdirSync(join(f.specDir, ".qa", "coverage", "run-1"), { recursive: true });
    symlinkSync(f.specDir, join(f.mirror, "e2e-link"));
    for (const root of [
      { mirrorDir: f.mirror, specDir: join(f.mirror, "e2e-link") },
      { mirrorDir: join(f.tmp, "elsewhere-mirror"), specDir: f.specDir },
      { mirrorDir: f.mirror, specDir: join(f.mirror, "no-such-dir") },
    ]) {
      assert.ok("reason" in listOwnedSpecDir(root, REL, 10), JSON.stringify(root));
    }
    for (const rel of ["", "/run-1", "../outside", ".qa/../../outside"]) {
      assert.ok("reason" in listOwnedSpecDir(f.root, rel, 10), JSON.stringify(rel));
    }
  });
});

test("an owned directory is listed up to the cap: exactly the cap is every entry, one more is a listing that says it was cut", () => {
  withFixture((f) => {
    const dir = join(f.specDir, ".qa", "coverage", "run-1");
    mkdirSync(dir, { recursive: true });
    for (const name of ["a", "b", "c", "d"]) writeFileSync(join(dir, name), "x");

    assert.deepEqual(listOwnedSpecDir(f.root, REL, 4), { names: ["a", "b", "c", "d"], truncated: false });
    const cut = listOwnedSpecDir(f.root, REL, 3);
    assert.ok("names" in cut && cut.truncated === true && cut.names.length === 3, "one past the cap is cut");
    assert.deepEqual(listOwnedSpecDir(f.root, REL, 0), { names: [], truncated: true }, "a cap of nothing lists nothing and says so");
  });
});

test("an owned directory that cannot be listed is refused, not taken for an empty one", { skip: NO_MODE_RESTRICTIONS }, () => {
  withFixture((f) => {
    const dir = join(f.specDir, ".qa", "coverage", "run-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.json"), "[]");
    chmodSync(dir, 0o000);
    try {
      const listing = listOwnedSpecDir(f.root, REL, 10);

      assert.ok("reason" in listing && listing.reason !== "");
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

function canCountDescriptors(): boolean {
  try {
    return readdirSync("/dev/fd").length > 0;
  } catch {
    return false;
  }
}

const NO_DESCRIPTOR_LISTING = canCountDescriptors() ? false : "/dev/fd is not available on this platform, so descriptor leaks cannot be counted";

test("a listing releases its directory handle, whether it is whole, cut or refused", { skip: NO_DESCRIPTOR_LISTING }, () => {
  withFixture((f) => {
    const dir = join(f.specDir, ".qa", "coverage", "run-1");
    mkdirSync(dir, { recursive: true });
    for (const name of ["a", "b", "c"]) writeFileSync(join(dir, name), "x");
    const open = (): number => readdirSync("/dev/fd").length;
    const before = open();

    for (let i = 0; i < 200; i++) {
      listOwnedSpecDir(f.root, REL, 10);
      listOwnedSpecDir(f.root, REL, 2);
      listOwnedSpecDir(f.root, "no/such/dir", 10);
    }

    assert.ok(open() - before < 20, `${open() - before} descriptors were left open by 600 listings`);
  });
});

test("listing an owned directory names a named pipe in it and never opens it", { skip: NO_NAMED_PIPES }, async () => {
  await withFixtureAsync(async (f) => {
    const dir = join(f.specDir, ".qa", "coverage", "run-1");
    mkdirSync(dir, { recursive: true });
    execFileSync("mkfifo", [join(dir, "planted.json")]);
    writeFileSync(join(dir, "real.json"), "[]");

    const listing = await withoutWaitingOnNamedPipe(join(dir, "planted.json"), () => listOwnedSpecDir(f.root, REL, 10));

    assert.deepEqual(listing, { names: ["planted.json", "real.json"], truncated: false });
  });
});
