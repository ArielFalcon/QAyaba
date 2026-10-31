/* A path is validated and then opened, and between the two a process the agent left running can swap what the path names: a directory above the file for a symlink, the file for another file, the file for a named pipe. O_NOFOLLOW covers only the last component, so the read ties the descriptor it opened to the file it validated: by the device and inode it finds before and after the open and, where the platform can say so, by the kernel's own path of the descriptor. A file is also read whole or not at all. Every swap and every partial read below is made by the test at the exact point of that sequence, through the injected fs seam, with the real calls around it: no real race is relied on. Fixtures live under os.tmpdir(). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfinedPathError,
  defaultSpecReadDeps,
  readConfinedSpecBytes,
  specReadDepsFor,
  type SpecReadDeps,
  type SpecRoot,
} from "../../src/shared-infrastructure/spec-path-confinement.ts";

/* <tmp>/mirror/e2e/{top.spec.ts, flows/ok.spec.ts} is the suite; <tmp>/outside mirrors it with files that hold the secret. */
interface Layout {
  tmp: string;
  mirror: string;
  specDir: string;
  flows: string;
  file: string;
  root: SpecRoot;
}

function withLayout(run: (layout: Layout) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), "qa-spec-seam-"));
  try {
    const mirror = join(tmp, "mirror");
    const specDir = join(mirror, "e2e");
    mkdirSync(join(specDir, "flows"), { recursive: true });
    mkdirSync(join(tmp, "outside", "flows"), { recursive: true });
    writeFileSync(join(specDir, "top.spec.ts"), "// top, inside the spec directory\n");
    writeFileSync(join(specDir, "flows", "ok.spec.ts"), "// ok, inside the spec directory\n");
    writeFileSync(join(tmp, "outside", "top.spec.ts"), "TOP SECRET");
    writeFileSync(join(tmp, "outside", "flows", "ok.spec.ts"), "TOP SECRET");
    run({ tmp, mirror, specDir, flows: join(specDir, "flows"), file: join(specDir, "flows", "ok.spec.ts"), root: { mirrorDir: mirror, specDir } });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* The real calls, without a kernel path: what is under test in the cases built on it is the identity of the descriptor, on every platform. */
const IDENTITY_ONLY: SpecReadDeps = { ...defaultSpecReadDeps, fdPath: () => undefined };

/* The seam with a swap made right before the validated path is opened. */
function swapBeforeOpen(swap: () => void): SpecReadDeps {
  return {
    ...IDENTITY_ONLY,
    open: (path, flags) => {
      swap();
      return IDENTITY_ONLY.open(path, flags);
    },
  };
}

/* The seam with a swap made after the descriptor exists and before it is judged. */
function swapAfterOpen(swap: () => void): SpecReadDeps {
  return {
    ...IDENTITY_ONLY,
    fstat: (fd) => {
      const stats = IDENTITY_ONLY.fstat(fd);
      swap();
      return stats;
    },
  };
}

/* The seam answering for the descriptor with another identity, or another kind of file, than the one that was validated. */
function describingAs(change: { dev?: bigint; ino?: bigint; regular?: boolean }): SpecReadDeps {
  return {
    ...IDENTITY_ONLY,
    fstat: (fd) => {
      const real = IDENTITY_ONLY.fstat(fd);
      return { dev: real.dev + (change.dev ?? 0n), ino: real.ino + (change.ino ?? 0n), size: real.size, isFile: () => change.regular ?? real.isFile() };
    },
  };
}

/* The seam answering for the kernel's path of the descriptor, with the real calls around it. `opened` receives the descriptor the open gave. */
function kernelPathIs(path: string | undefined, opened: { fd: number } = { fd: -1 }): SpecReadDeps {
  return {
    ...defaultSpecReadDeps,
    open: (p, flags) => (opened.fd = defaultSpecReadDeps.open(p, flags)),
    fdPath: () => path,
  };
}

/* The seam reading a file in pieces, as a read of a slow or network filesystem may: never more than `most` bytes a call. */
function readingAtMost(most: number): SpecReadDeps {
  return { ...IDENTITY_ONLY, read: (fd, buffer, offset, length, position) => IDENTITY_ONLY.read(fd, buffer, offset, Math.min(length, most), position) };
}

/* The seam reading `bytes` bytes of the file and then reporting the end of it: a file that shrank between the judgement of its size and the read. */
function endingAfter(bytes: number): SpecReadDeps {
  let given = 0;
  return {
    ...IDENTITY_ONLY,
    read: (fd, buffer, offset, length, position) => {
      const wanted = Math.min(length, bytes - given);
      if (wanted <= 0) return 0;
      const got = IDENTITY_ONLY.read(fd, buffer, offset, wanted, position);
      given += got;
      return got;
    },
  };
}

const refusedAs = (reported: string) => (err: unknown): boolean => err instanceof ConfinedPathError && err.path === reported;

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

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-spec-seam-fifo-probe-"));
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
const NOT_LINUX = process.platform === "linux" ? false : "the kernel path of a descriptor comes from procfs, which only Linux has";
const NO_DESCRIPTOR_LISTING = (() => {
  try {
    return readdirSync("/dev/fd").length > 0 ? false : "/dev/fd lists nothing on this platform, so descriptor leaks cannot be counted";
  } catch {
    return "/dev/fd is not available on this platform, so descriptor leaks cannot be counted";
  }
})();

/* ── the identity of the descriptor ────────────────────────────────────────────────────────────── */

test("a directory above the validated file, swapped for a symlink out of the spec directory just before the open, is not read through", () => {
  withLayout((l) => {
    const deps = swapBeforeOpen(() => {
      renameSync(l.flows, `${l.flows}-moved`);
      symlinkSync(join(l.tmp, "outside", "flows"), l.flows);
    });

    assert.throws(() => readConfinedSpecBytes(l.root, "flows/ok.spec.ts", undefined, deps), refusedAs("flows/ok.spec.ts"));
    assert.equal(readFileSync(l.file, "utf8"), "TOP SECRET", "the swap did redirect the path: a read that followed it would have returned the secret");
  });
});

test("the spec directory itself, swapped for a symlink out of the mirror just before the open, is not read through", () => {
  withLayout((l) => {
    const deps = swapBeforeOpen(() => {
      renameSync(l.specDir, `${l.specDir}-moved`);
      symlinkSync(join(l.tmp, "outside"), l.specDir);
    });

    assert.throws(() => readConfinedSpecBytes(l.root, "top.spec.ts", undefined, deps), refusedAs("top.spec.ts"));
    assert.equal(readFileSync(join(l.specDir, "top.spec.ts"), "utf8"), "TOP SECRET", "the swap did redirect the path");
  });
});

test("a swap that is undone before the descriptor is judged still leaves the descriptor on the wrong file, and is refused", () => {
  withLayout((l) => {
    const swap = (): void => {
      renameSync(l.flows, `${l.flows}-moved`);
      symlinkSync(join(l.tmp, "outside", "flows"), l.flows);
    };
    const unswap = (): void => {
      unlinkSync(l.flows);
      renameSync(`${l.flows}-moved`, l.flows);
    };
    const deps: SpecReadDeps = {
      ...IDENTITY_ONLY,
      open: (path, flags) => {
        swap();
        return IDENTITY_ONLY.open(path, flags);
      },
      fstat: (fd) => {
        const stats = IDENTITY_ONLY.fstat(fd);
        unswap();
        return stats;
      },
    };

    assert.throws(() => readConfinedSpecBytes(l.root, "flows/ok.spec.ts", undefined, deps), refusedAs("flows/ok.spec.ts"));
  });
});

test("the validated file, replaced by another regular file just before the open, is not the file that is read", () => {
  withLayout((l) => {
    const deps = swapBeforeOpen(() => {
      writeFileSync(`${l.file}.replacement`, "// a different file that took its place\n");
      renameSync(`${l.file}.replacement`, l.file);
    });

    assert.throws(() => readConfinedSpecBytes(l.root, "flows/ok.spec.ts", undefined, deps), refusedAs("flows/ok.spec.ts"));
  });
});

test("the validated file, replaced by another file after the open and before the descriptor is judged, is refused", () => {
  withLayout((l) => {
    const deps = swapAfterOpen(() => {
      writeFileSync(`${l.file}.replacement`, "// a different file that took its place\n");
      renameSync(`${l.file}.replacement`, l.file);
    });

    assert.throws(() => readConfinedSpecBytes(l.root, "flows/ok.spec.ts", undefined, deps), refusedAs("flows/ok.spec.ts"));
  });
});

test("the validated file, removed after the open and before the descriptor is judged, is refused", () => {
  withLayout((l) => {
    const deps = swapAfterOpen(() => unlinkSync(l.file));

    assert.throws(() => readConfinedSpecBytes(l.root, "flows/ok.spec.ts", undefined, deps), refusedAs("flows/ok.spec.ts"));
  });
});

/* Opening a named pipe for reading waits for a writer that never comes. A pipe swapped in after the check must not make the open wait: it opens at once and is refused when the descriptor is judged. The flag is checked before the pipe is put in place, so a reader that would wait on it fails here instead of hanging the run. */
test("the validated file, replaced by a named pipe just before the open, is refused without the open waiting for a writer", { skip: NO_NAMED_PIPES }, () => {
  withLayout((l) => {
    const deps: SpecReadDeps = {
      ...IDENTITY_ONLY,
      open: (path, flags) => {
        assert.notEqual(flags & constants.O_NONBLOCK, 0, "the open must not wait for a writer");
        unlinkSync(l.file);
        execFileSync("mkfifo", [l.file]);
        return IDENTITY_ONLY.open(path, flags);
      },
    };

    assert.throws(() => readConfinedSpecBytes(l.root, "flows/ok.spec.ts", undefined, deps), refusedAs("flows/ok.spec.ts"));
  });
});

test("the validated file, replaced by a symlink to a file outside the spec directory just before the open, is not read", () => {
  withLayout((l) => {
    const deps = swapBeforeOpen(() => {
      unlinkSync(l.file);
      symlinkSync(join(l.tmp, "outside", "flows", "ok.spec.ts"), l.file);
    });

    assert.throws(() => readConfinedSpecBytes(l.root, "flows/ok.spec.ts", undefined, deps), (err: unknown) => err instanceof Error && !err.message.includes("TOP SECRET"));
    assert.equal(readFileSync(l.file, "utf8"), "TOP SECRET", "the swap did redirect the path");
  });
});

test("a descriptor that answers with another inode, another device or another kind of file than the validated one is refused, each on its own", () => {
  withLayout((l) => {
    for (const [what, deps] of [
      ["another inode", describingAs({ ino: 1n })],
      ["another device", describingAs({ dev: 1n })],
      ["not a regular file", describingAs({ regular: false })],
    ] as const) {
      assert.throws(() => readConfinedSpecBytes(l.root, "top.spec.ts", undefined, deps), refusedAs("top.spec.ts"), what);
    }
    assert.equal(readConfinedSpecBytes(l.root, "top.spec.ts", undefined, describingAs({})).toString("utf8"), "// top, inside the spec directory\n", "the same identity is read as before");
  });
});

/* ── the kernel's path of the descriptor ───────────────────────────────────────────────────────── */

/* The identities cannot tell a swap that a looping process makes at the right instants: each lstat follows the directories above the file, so an attacker that alternates the path between two states can have the realpath see one state and the lstats, the open and the second look see the other, and every identity then agrees on a file outside the spec directory. The descriptor itself does not change with the path: the kernel names the file it really opened. */
/* The kernel names real paths. Every path a case gives it as the kernel's answer is built from the real location of the layout: os.tmpdir() sits behind a symlink on macOS, and a path through it would be refused for being spelled differently, not for lying outside. */
test("a descriptor the kernel places outside the spec directory is refused and released, though every identity agrees with the validated file", () => {
  withLayout((l) => {
    const opened = { fd: -1 };
    const deps = kernelPathIs(join(realpathSync(l.tmp), "outside", "flows", "ok.spec.ts"), opened);

    assert.throws(() => readConfinedSpecBytes(l.root, "flows/ok.spec.ts", undefined, deps), refusedAs("flows/ok.spec.ts"));
    assertReleased(opened.fd);
  });
});

test("a descriptor the kernel places elsewhere in the mirror, or in a sibling of the spec directory whose name starts with its name, is outside the spec directory", () => {
  withLayout((l) => {
    const mirror = realpathSync(l.mirror);
    for (const elsewhere of [join(mirror, "src", "ok.spec.ts"), join(mirror, "e2e-evil", "flows", "ok.spec.ts"), join(mirror, "ok.spec.ts")]) {
      const deps = kernelPathIs(elsewhere);
      assert.throws(() => readConfinedSpecBytes(l.root, "flows/ok.spec.ts", undefined, deps), refusedAs("flows/ok.spec.ts"), elsewhere);
    }
  });
});

test("a descriptor the kernel places inside the spec directory is read", () => {
  withLayout((l) => {
    const deps = kernelPathIs(realpathSync(l.file));

    assert.equal(readConfinedSpecBytes(l.root, "flows/ok.spec.ts", undefined, deps).toString("utf8"), "// ok, inside the spec directory\n");
  });
});

test("the kernel is asked about the descriptor the open gave, and nothing else", () => {
  withLayout((l) => {
    const opened = { fd: -1 };
    const asked: number[] = [];
    const deps: SpecReadDeps = { ...kernelPathIs(undefined, opened), fdPath: (fd) => { asked.push(fd); return realpathSync(l.file); } };

    readConfinedSpecBytes(l.root, "flows/ok.spec.ts", undefined, deps);

    assert.deepEqual(asked, [opened.fd]);
  });
});

test("where the platform has no path for a descriptor, the identity of the descriptor decides alone: it reads a file that matches and refuses one that does not", () => {
  withLayout((l) => {
    assert.equal(readConfinedSpecBytes(l.root, "top.spec.ts", undefined, kernelPathIs(undefined)).toString("utf8"), "// top, inside the spec directory\n");
    assert.throws(() => readConfinedSpecBytes(l.root, "top.spec.ts", undefined, describingAs({ ino: 1n })), refusedAs("top.spec.ts"));
  });
});

test("a failure to read the kernel path of a descriptor is thrown as it is and the descriptor is released: the weaker check never stands in for it", () => {
  withLayout((l) => {
    const opened = { fd: -1 };
    const deps: SpecReadDeps = { ...kernelPathIs(undefined, opened), fdPath: () => { throw new Error("procfs is gone"); } };

    assert.throws(() => readConfinedSpecBytes(l.root, "top.spec.ts", undefined, deps), /procfs is gone/);
    assertReleased(opened.fd);
  });
});

test("the kernel path comes from procfs on Linux and from nowhere on the other platforms", () => {
  const asked: string[] = [];
  const readlink = (path: string): string => {
    asked.push(path);
    return `/real${path}`;
  };

  assert.equal(specReadDepsFor("linux", readlink).fdPath(7), "/real/proc/self/fd/7");
  assert.equal(specReadDepsFor("linux", readlink).fdPath(12), "/real/proc/self/fd/12");
  assert.deepEqual(asked, ["/proc/self/fd/7", "/proc/self/fd/12"]);
  for (const platform of ["darwin", "win32", "freebsd", "sunos"] as const) {
    assert.equal(specReadDepsFor(platform, readlink).fdPath(7), undefined, platform);
  }
  assert.equal(asked.length, 2, "the other platforms never ask procfs");
});

test("on Linux the kernel path of a descriptor is the real path of the file, and of the file a swapped directory led to", { skip: NOT_LINUX }, () => {
  withLayout((l) => {
    const plain = defaultSpecReadDeps.open(l.file, constants.O_RDONLY);
    try {
      assert.equal(defaultSpecReadDeps.fdPath(plain), realpathSync(l.file));
    } finally {
      closeSync(plain);
    }

    renameSync(l.flows, `${l.flows}-moved`);
    symlinkSync(join(l.tmp, "outside", "flows"), l.flows);
    const swapped = defaultSpecReadDeps.open(l.file, constants.O_RDONLY);
    try {
      assert.equal(defaultSpecReadDeps.fdPath(swapped), realpathSync(join(l.tmp, "outside", "flows", "ok.spec.ts")));
    } finally {
      closeSync(swapped);
    }
  });
});

test("on Linux a directory swapped for a symlink out of the spec directory just before the open is refused by the kernel path, as it is for a fake one", { skip: NOT_LINUX }, () => {
  withLayout((l) => {
    const faked = reasonOf(() => readConfinedSpecBytes(l.root, "flows/ok.spec.ts", undefined, kernelPathIs(join(realpathSync(l.tmp), "outside", "flows", "ok.spec.ts"))));
    const swapping: SpecReadDeps = {
      ...defaultSpecReadDeps,
      open: (path, flags) => {
        renameSync(l.flows, `${l.flows}-moved`);
        symlinkSync(join(l.tmp, "outside", "flows"), l.flows);
        return defaultSpecReadDeps.open(path, flags);
      },
    };

    assert.equal(reasonOf(() => readConfinedSpecBytes(l.root, "flows/ok.spec.ts", undefined, swapping)), faked);
  });
});

/* ── a file is read whole or not at all ────────────────────────────────────────────────────────── */

test("a file that a read returns in pieces is read whole", () => {
  withLayout((l) => {
    writeFileSync(join(l.specDir, "pieces.spec.ts"), "0123456789abcdefghij\n");

    for (const most of [1, 3, 7, 20, 21, 100]) {
      assert.equal(readConfinedSpecBytes(l.root, "pieces.spec.ts", undefined, readingAtMost(most)).toString("utf8"), "0123456789abcdefghij\n", `${most} bytes a call`);
    }
  });
});

test("a file that ends before the size it was judged to have is refused as a short read, never returned truncated, and the descriptor is released", () => {
  withLayout((l) => {
    writeFileSync(join(l.specDir, "shrunk.spec.ts"), "0123456789abcdefghij\n");

    for (const bytes of [0, 1, 7, 20]) {
      const opened = { fd: -1 };
      const deps: SpecReadDeps = { ...endingAfter(bytes), open: (p, flags) => (opened.fd = IDENTITY_ONLY.open(p, flags)) };
      assert.throws(() => readConfinedSpecBytes(l.root, "shrunk.spec.ts", undefined, deps), refusedAs("shrunk.spec.ts"), `${bytes} bytes before the end`);
      assertReleased(opened.fd);
    }
    assert.equal(readConfinedSpecBytes(l.root, "shrunk.spec.ts", undefined, endingAfter(21)).toString("utf8"), "0123456789abcdefghij\n", "a file that is whole is read");
  });
});

test("an empty file is returned without a read", () => {
  withLayout((l) => {
    writeFileSync(join(l.specDir, "empty.spec.ts"), "");
    const deps: SpecReadDeps = { ...IDENTITY_ONLY, read: () => assert.fail("a read of an empty file") };

    assert.equal(readConfinedSpecBytes(l.root, "empty.spec.ts", undefined, deps).length, 0);
  });
});

/* ── what the refusals say, and what a refusal releases ────────────────────────────────────────── */

test("the refusal of a swapped file gives a reason of its own, apart from the other refusals", () => {
  withLayout((l) => {
    writeFileSync(join(l.specDir, "shrunk.spec.ts"), "0123456789\n");
    const reasons = [
      reasonOf(() => readConfinedSpecBytes(l.root, "top.spec.ts", undefined, describingAs({ ino: 1n }))),
      reasonOf(() => readConfinedSpecBytes(l.root, "top.spec.ts", undefined, kernelPathIs(join(realpathSync(l.tmp), "outside", "top.spec.ts")))),
      reasonOf(() => readConfinedSpecBytes(l.root, "shrunk.spec.ts", undefined, endingAfter(3))),
      reasonOf(() => readConfinedSpecBytes(l.root, "missing.spec.ts")),
      reasonOf(() => readConfinedSpecBytes(l.root, "../outside/top.spec.ts")),
      reasonOf(() => readConfinedSpecBytes(l.root, "top.spec.ts", 1)),
    ];

    for (const reason of reasons) assert.notEqual(reason, "");
    assert.equal(new Set(reasons).size, reasons.length, `two refusals share a reason: ${JSON.stringify(reasons)}`);
  });
});

test("the descriptor is opened read-only, without following a link in the last component and without waiting on a pipe", () => {
  withLayout((l) => {
    let flags = -1;
    const deps: SpecReadDeps = {
      ...IDENTITY_ONLY,
      open: (path, requested) => {
        flags = requested;
        return IDENTITY_ONLY.open(path, requested);
      },
    };

    readConfinedSpecBytes(l.root, "top.spec.ts", undefined, deps);

    assert.equal(flags & (constants.O_WRONLY | constants.O_RDWR), 0, "read-only");
    assert.notEqual(flags & constants.O_NOFOLLOW, 0, "a symlink in the last component is not followed");
    assert.notEqual(flags & constants.O_NONBLOCK, 0, "opening a pipe does not wait for a writer");
  });
});

test("a descriptor that is refused as changed is released", { skip: NO_DESCRIPTOR_LISTING }, () => {
  withLayout((l) => {
    const open = (): number => readdirSync("/dev/fd").length;
    const deps = describingAs({ ino: 1n });
    const before = open();
    for (let i = 0; i < 200; i++) {
      assert.throws(() => readConfinedSpecBytes(l.root, "top.spec.ts", undefined, deps), ConfinedPathError);
    }
    assert.ok(open() - before < 20, `${open() - before} descriptors were left open by 200 refused reads`);
  });
});
