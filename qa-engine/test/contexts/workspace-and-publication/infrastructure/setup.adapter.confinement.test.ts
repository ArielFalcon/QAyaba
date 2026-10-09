/* What setup reads and replaces in the e2e project is in a directory the agent writes into, and some of it outlives a run: `git clean -fd -e node_modules` leaves the install marker in place from one run to the next, so a named pipe planted there would hold the orchestrator on every later run, and a link at the fixtures file or at the ignore file would have the capture block or a line appended to a file outside the project. Setup reads those files strictly and replaces them through a temporary file renamed over the target: a file it cannot vouch for fails the setup, aloud (an infra-error), and is never waited on, followed or skipped. The one thing that would then fail every later run for good, a marker or a node_modules that is refused, is removed without being opened or followed, once, and the marker is read again; the seed is copied in and flows/ is made through the same strict calls, so nothing is made or written through a link. Every case runs against real files, links and pipes under os.tmpdir(); the pipe cases run under the watch of test/support/named-pipe-watch.ts, so a regression fails fast instead of holding the run. */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FAILURE_CAPTURE_MARKER,
  MAX_INSTALL_MARKER_BYTES,
  MAX_LOCK_FILE_BYTES,
  SetupAdapter,
  nodeFsDeps,
} from "@contexts/workspace-and-publication/infrastructure/setup.adapter.ts";
import { ConfinedPathError, MAX_SPEC_SOURCE_BYTES, defaultSpecReadDeps } from "../../../../src/shared-infrastructure/spec-path-confinement.ts";
import type { SandboxedBinaryRunner, SandboxedRunRequest, SandboxedRunResult } from "../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { withoutWaitingOnNamedPipe } from "../../../support/named-pipe-watch.ts";

const REAL_SEED_DIR = fileURLToPath(new URL("../../../../../config/e2e", import.meta.url));
const SEED_REVISIONS_DIR = fileURLToPath(new URL("./__fixtures__/seed-revisions", import.meta.url));

/* The exact bytes of a seed file as an earlier revision shipped it into watched repos. */
const shippedRevision = (name: string): string => readFileSync(join(SEED_REVISIONS_DIR, name), "utf8");
const PRECIOUS = "PRECIOUS: a file outside the project that no setup step may touch\n";
const SECRET_MARK = "SECRETv1-hunter2";
const LOCK = '{"name":"e2e","lockfileVersion":3}';
const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const LOCK_HASH = sha256(LOCK);

/* <tmp>/e2e is the project; <tmp>/outside holds what no step may reach. */
interface Project {
  tmp: string;
  e2e: string;
  outside: string;
  victim: string;
}

async function withProject(run: (p: Project) => Promise<void> | void): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-setup-confined-"));
  const e2e = join(tmp, "e2e");
  const outside = join(tmp, "outside");
  mkdirSync(e2e);
  mkdirSync(outside);
  writeFileSync(join(e2e, "package.json"), "{}");
  const victim = join(outside, "victim.txt");
  writeFileSync(victim, PRECIOUS);
  try {
    await run({ tmp, e2e, outside, victim });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-setup-confined-fifo-probe-"));
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

/* A file whose mode is 000 cannot be read by an account that the mode binds: not by root, and not on a platform without modes. */
const NO_MODE_RESTRICTIONS = process.platform === "win32" || process.getuid?.() === 0 ? "the account that runs the tests is not bound by file modes, so the cases that rely on them are not exercised" : false;

/* A runner that counts the installs, keeps what it was asked to run and, when it is given one, does something while it runs (what an install script could do). */
function runnerThat(during?: () => void): { runner: SandboxedBinaryRunner; installs: () => number; asked: () => string[][] } {
  const asked: string[][] = [];
  const done: SandboxedRunResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  return {
    runner: { run: async (req: SandboxedRunRequest) => { asked.push([...req.args]); during?.(); return done; } },
    installs: () => asked.length,
    asked: () => asked,
  };
}

const adapterOver = (runner: SandboxedBinaryRunner, seedDir = REAL_SEED_DIR): SetupAdapter => new SetupAdapter({ fs: nodeFsDeps, runner, seedDir });

/* A refusal is the module's own error: it names the file as setup asked for it and says why. */
const refusedAt = (path: string) => (err: unknown): boolean => err instanceof ConfinedPathError && err.path === path && err.reason !== "";

/* The marker as setup asks for it, below the project: the one path whose removal the cases that count them are about. */
const MARKER_REL = "node_modules/.install-hash";
const markerOf = (e2e: string): string => join(e2e, "node_modules", ".install-hash");
const lockOf = (e2e: string): string => join(e2e, "package-lock.json");

/* A project that has installed once: a lock, and a node_modules with the marker the install left. */
function installed(e2e: string, marker: string = LOCK_HASH): void {
  writeFileSync(lockOf(e2e), LOCK);
  mkdirSync(join(e2e, "node_modules"));
  writeFileSync(markerOf(e2e), marker);
}

const temporaryFilesIn = (dir: string): string[] => readdirSync(dir).filter((name) => name.endsWith(".tmp"));

/* ── the install marker and the lock file ──────────────────────────────────────────────────────── */

/* What setup says on the way, which goes to logs. */
async function capturing<T>(run: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    return { value: await run(), warnings };
  } finally {
    warn.mock.restore();
  }
}

/* The marker and node_modules survive `git clean -fd -e node_modules` from one run to the next, so what refuses the strict read of the marker there refuses it on every later run unless setup removes it: it does, without opening it or following it, says so, and reads the marker once more. With no marker the install is not skipped, so it runs. */
test("an install marker that is a named pipe is removed without being opened, said aloud, and the install it could not skip runs", { skip: NO_NAMED_PIPES }, async () => {
  await withProject(async (p) => {
    writeFileSync(lockOf(p.e2e), LOCK);
    mkdirSync(join(p.e2e, "node_modules"));
    execFileSync("mkfifo", [markerOf(p.e2e)]);
    const { runner, installs } = runnerThat();

    const { warnings } = await capturing(() => withoutWaitingOnNamedPipe(markerOf(p.e2e), () => adapterOver(runner).setup(p.e2e)));

    assert.equal(installs(), 1);
    assert.equal(readFileSync(markerOf(p.e2e), "utf8"), LOCK_HASH, "and leaves a marker of its own");
    assert.ok(warnings.some((w) => w.includes(markerOf(p.e2e))), `the removal is said: ${JSON.stringify(warnings)}`);
  });
});

test("an install marker that is a link is removed, the file it points at is not touched, and the install is not skipped on its word", async () => {
  await withProject(async (p) => {
    writeFileSync(lockOf(p.e2e), LOCK);
    mkdirSync(join(p.e2e, "node_modules"));
    writeFileSync(join(p.outside, "marker.txt"), LOCK_HASH);
    symlinkSync(join(p.outside, "marker.txt"), markerOf(p.e2e));
    const { runner, installs } = runnerThat();

    await capturing(() => adapterOver(runner).setup(p.e2e));

    assert.equal(installs(), 1, "the marker behind the link said the install was current, and was not believed");
    assert.equal(lstatSync(markerOf(p.e2e)).isFile(), true, "the marker is a file of the project again");
    assert.equal(readFileSync(join(p.outside, "marker.txt"), "utf8"), LOCK_HASH, "and the file the link pointed at is as it was");
  });
});

test("a node_modules that is a link is removed, nothing in the directory it points at is touched, and the marker behind it is not believed", async () => {
  await withProject(async (p) => {
    writeFileSync(lockOf(p.e2e), LOCK);
    mkdirSync(join(p.outside, "nm", "pkg"), { recursive: true });
    writeFileSync(join(p.outside, "nm", ".install-hash"), LOCK_HASH);
    writeFileSync(join(p.outside, "nm", "pkg", "index.js"), "module.exports = 1;\n");
    symlinkSync(join(p.outside, "nm"), join(p.e2e, "node_modules"));
    const { runner, installs } = runnerThat();

    const { warnings } = await capturing(() => adapterOver(runner).setup(p.e2e));

    assert.equal(installs(), 1);
    assert.equal(lstatSync(join(p.e2e, "node_modules")).isDirectory(), true, "node_modules is a directory of the project again");
    assert.deepEqual(readdirSync(join(p.outside, "nm")).sort(), [".install-hash", "pkg"], "the directory it pointed at is as it was");
    assert.equal(readFileSync(join(p.outside, "nm", "pkg", "index.js"), "utf8"), "module.exports = 1;\n");
    assert.ok(warnings.some((w) => w.includes(join(p.e2e, "node_modules"))), JSON.stringify(warnings));
  });
});

test("a node_modules that is a named pipe is removed without being opened and the install runs", { skip: NO_NAMED_PIPES }, async () => {
  await withProject(async (p) => {
    writeFileSync(lockOf(p.e2e), LOCK);
    execFileSync("mkfifo", [join(p.e2e, "node_modules")]);
    const { runner, installs } = runnerThat();

    await capturing(() => withoutWaitingOnNamedPipe(join(p.e2e, "node_modules"), () => adapterOver(runner).setup(p.e2e)));

    assert.equal(installs(), 1);
    assert.equal(lstatSync(join(p.e2e, "node_modules")).isDirectory(), true);
  });
});

test("a node_modules that is a regular file is removed and the install runs", async () => {
  await withProject(async (p) => {
    writeFileSync(lockOf(p.e2e), LOCK);
    writeFileSync(join(p.e2e, "node_modules"), "not a directory");
    const { runner, installs } = runnerThat();

    await capturing(() => adapterOver(runner).setup(p.e2e));

    assert.equal(installs(), 1);
    assert.equal(lstatSync(join(p.e2e, "node_modules")).isDirectory(), true);
  });
});

test("an install marker that is a directory is set aside with what is in it, nothing is deleted, and the install runs", async () => {
  await withProject(async (p) => {
    writeFileSync(lockOf(p.e2e), LOCK);
    mkdirSync(join(markerOf(p.e2e), "deep"), { recursive: true });
    writeFileSync(join(markerOf(p.e2e), "deep", "file.txt"), "kept");
    const { runner, installs } = runnerThat();

    await capturing(() => adapterOver(runner).setup(p.e2e));

    assert.equal(installs(), 1);
    assert.equal(readFileSync(markerOf(p.e2e), "utf8"), LOCK_HASH);
    const aside = readdirSync(join(p.e2e, "node_modules")).filter((name) => name.startsWith(".install-hash.refused-"));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(join(p.e2e, "node_modules", aside[0]!, "deep", "file.txt"), "utf8"), "kept");
  });
});

test("a refusal with nothing to remove fails the setup, after one look and no more, and no install runs", { skip: NO_NAMED_PIPES }, async () => {
  await withProject(async (p) => {
    writeFileSync(lockOf(p.e2e), LOCK);
    mkdirSync(join(p.e2e, "node_modules"));
    execFileSync("mkfifo", [markerOf(p.e2e)]);
    let purges = 0;
    const fs = { ...nodeFsDeps, purgeRefused: (_root: unknown, rel: string) => { if (rel === MARKER_REL) purges += 1; return { nothing: true } as const; } };
    const { runner, installs } = runnerThat();

    await withoutWaitingOnNamedPipe(markerOf(p.e2e), () => assert.rejects(() => new SetupAdapter({ fs, runner, seedDir: REAL_SEED_DIR }).setup(p.e2e), refusedAt(markerOf(p.e2e))));

    assert.equal(purges, 1, "tried once");
    assert.equal(installs(), 0);
  });
});

test("a refusal that survives a removal fails the setup, after one removal and no more, and no install runs", { skip: NO_NAMED_PIPES }, async () => {
  await withProject(async (p) => {
    writeFileSync(lockOf(p.e2e), LOCK);
    mkdirSync(join(p.e2e, "node_modules"));
    execFileSync("mkfifo", [markerOf(p.e2e)]);
    let purges = 0;
    /* A removal that says the name is free while the pipe is still there, as one that something plants again would: the marker is refused a second time. */
    const fs = { ...nodeFsDeps, purgeRefused: (_root: unknown, rel: string) => { if (rel !== MARKER_REL) return { nothing: true } as const; purges += 1; return { removed: MARKER_REL, how: "unlinked" } as const; } };
    const { runner, installs } = runnerThat();

    const { warnings } = await capturing(() => withoutWaitingOnNamedPipe(markerOf(p.e2e), () => assert.rejects(() => new SetupAdapter({ fs, runner, seedDir: REAL_SEED_DIR }).setup(p.e2e), refusedAt(markerOf(p.e2e)))));

    assert.equal(purges, 1, "removed once, and not again for the second refusal");
    assert.equal(installs(), 0);
    assert.equal(warnings.filter((w) => w.includes(markerOf(p.e2e))).length, 1, `the removal is said once: ${JSON.stringify(warnings)}`);
    assert.equal(lstatSync(markerOf(p.e2e)).isFIFO(), true, "and the pipe is where it was");
  });
});

test("a removal that fails fails the setup with the refusal, said with the code of the failure and nothing else", { skip: NO_NAMED_PIPES }, async () => {
  await withProject(async (p) => {
    writeFileSync(lockOf(p.e2e), LOCK);
    mkdirSync(join(p.e2e, "node_modules"));
    execFileSync("mkfifo", [markerOf(p.e2e)]);
    const fs = { ...nodeFsDeps, purgeRefused: () => { throw Object.assign(new Error(`denied ${SECRET_MARK}`), { code: "EPERM" }); } };
    const { runner, installs } = runnerThat();

    const { warnings } = await capturing(() => withoutWaitingOnNamedPipe(markerOf(p.e2e), () => assert.rejects(() => new SetupAdapter({ fs, runner, seedDir: REAL_SEED_DIR }).setup(p.e2e), refusedAt(markerOf(p.e2e)))));

    assert.equal(installs(), 0);
    assert.ok(warnings.some((w) => w.includes("EPERM")), JSON.stringify(warnings));
    assert.ok(!warnings.join("\n").includes(SECRET_MARK), "an error's message is not quoted");
  });
});

test("a lock file that is a named pipe is not removed: only the marker and the node_modules above it are", { skip: NO_NAMED_PIPES }, async () => {
  await withProject(async (p) => {
    mkdirSync(join(p.e2e, "node_modules"));
    writeFileSync(markerOf(p.e2e), LOCK_HASH);
    execFileSync("mkfifo", [lockOf(p.e2e)]);
    let purges = 0;
    const fs = { ...nodeFsDeps, purgeRefused: (...args: Parameters<typeof nodeFsDeps.purgeRefused>) => { if (args[1] === MARKER_REL) purges += 1; return nodeFsDeps.purgeRefused(...args); } };
    const { runner } = runnerThat();

    await withoutWaitingOnNamedPipe(lockOf(p.e2e), () => assert.rejects(() => new SetupAdapter({ fs, runner, seedDir: REAL_SEED_DIR }).setup(p.e2e), refusedAt(lockOf(p.e2e))));

    assert.equal(purges, 0);
    assert.equal(lstatSync(lockOf(p.e2e)).isFIFO(), true, "the pipe is where it was");
  });
});

test("after the removal and the install the next setup finds the install current and runs nothing", async () => {
  await withProject(async (p) => {
    writeFileSync(lockOf(p.e2e), LOCK);
    writeFileSync(join(p.e2e, "node_modules"), "not a directory");
    const { runner, installs } = runnerThat();

    await capturing(() => adapterOver(runner).setup(p.e2e));
    await capturing(() => adapterOver(runner).setup(p.e2e));

    assert.equal(installs(), 1);
  });
});

test("a lock file that is a named pipe fails the setup and is not waited on", { skip: NO_NAMED_PIPES }, async () => {
  await withProject(async (p) => {
    mkdirSync(join(p.e2e, "node_modules"));
    writeFileSync(markerOf(p.e2e), LOCK_HASH);
    execFileSync("mkfifo", [lockOf(p.e2e)]);
    const { runner, installs } = runnerThat();

    await withoutWaitingOnNamedPipe(lockOf(p.e2e), () => assert.rejects(() => adapterOver(runner).setup(p.e2e), refusedAt(lockOf(p.e2e))));

    assert.equal(installs(), 0);
  });
});

/* With no marker the install is not skipped, so it is the install that meets the lock: a runner that was handed a pipe for a lock would wait on it until its own timeout, with the whole queue behind it. */
test("a lock file that is a named pipe or a link fails the setup before an install is started, though there is no marker yet", { skip: NO_NAMED_PIPES }, async () => {
  await withProject(async (p) => {
    execFileSync("mkfifo", [lockOf(p.e2e)]);
    const pipe = runnerThat();
    await withoutWaitingOnNamedPipe(lockOf(p.e2e), () => assert.rejects(() => adapterOver(pipe.runner).setup(p.e2e), refusedAt(lockOf(p.e2e))));
    assert.equal(pipe.installs(), 0, "a pipe");

    rmSync(lockOf(p.e2e));
    writeFileSync(join(p.outside, "lock.json"), LOCK);
    symlinkSync(join(p.outside, "lock.json"), lockOf(p.e2e));
    const link = runnerThat();
    await assert.rejects(() => adapterOver(link.runner).setup(p.e2e), refusedAt(lockOf(p.e2e)));
    assert.equal(link.installs(), 0, "a link");
  });
});

test("a lock file that is a link fails the setup, and the install is not run with a lock from outside the project", async () => {
  await withProject(async (p) => {
    mkdirSync(join(p.e2e, "node_modules"));
    writeFileSync(markerOf(p.e2e), LOCK_HASH);
    writeFileSync(join(p.outside, "lock.json"), LOCK);
    symlinkSync(join(p.outside, "lock.json"), lockOf(p.e2e));
    const { runner, installs } = runnerThat();

    await assert.rejects(() => adapterOver(runner).setup(p.e2e), refusedAt(lockOf(p.e2e)));

    assert.equal(installs(), 0);
  });
});

/* The cache itself is unchanged: the marker the last install left, compared with the lock, is the only thing that skips an install. */
test("an install whose marker holds the lock's hash is skipped, whether or not the marker ends in whitespace", async () => {
  await withProject(async (p) => {
    installed(p.e2e, `${LOCK_HASH}\n`);
    const { runner, installs } = runnerThat();

    await adapterOver(runner).setup(p.e2e);

    assert.equal(installs(), 0);
  });
});

test("an install whose marker holds another hash, or has none, or has no lock to compare with, runs, and leaves the marker current", async () => {
  await withProject(async (p) => {
    installed(p.e2e, sha256("an earlier lock"));
    const stale = runnerThat();
    await adapterOver(stale.runner).setup(p.e2e);
    assert.equal(stale.installs(), 1, "a stale marker");
    assert.equal(readFileSync(markerOf(p.e2e), "utf8"), LOCK_HASH, "and the install leaves it current");

    rmSync(markerOf(p.e2e));
    const absent = runnerThat();
    await adapterOver(absent.runner).setup(p.e2e);
    assert.equal(absent.installs(), 1, "no marker");
    assert.equal(readFileSync(markerOf(p.e2e), "utf8"), LOCK_HASH);

    rmSync(join(p.e2e, "node_modules"), { recursive: true });
    const nothingInstalled = runnerThat();
    await adapterOver(nothingInstalled.runner).setup(p.e2e);
    assert.equal(nothingInstalled.installs(), 1, "no node_modules");
  });
});

test("an install is npm ci when the project has a lock file and npm install when it has none", async () => {
  await withProject(async (p) => {
    const withoutLock = runnerThat();
    await adapterOver(withoutLock.runner).setup(p.e2e);

    writeFileSync(lockOf(p.e2e), LOCK);
    const withLock = runnerThat();
    await adapterOver(withLock.runner).setup(p.e2e);

    assert.deepEqual(withoutLock.asked(), [["install"]]);
    assert.deepEqual(withLock.asked(), [["ci"]]);
  });
});

test("an install with no lock file runs, and the marker that was there is left as it was, since there is no hash to say it is current", async () => {
  await withProject(async (p) => {
    mkdirSync(join(p.e2e, "node_modules"));
    writeFileSync(markerOf(p.e2e), LOCK_HASH);
    const { runner, installs } = runnerThat();

    await adapterOver(runner).setup(p.e2e);

    assert.equal(installs(), 1);
    assert.equal(readFileSync(markerOf(p.e2e), "utf8"), LOCK_HASH, "the marker that was there is not rewritten with nothing to say");
  });
});

test("a marker that cannot be read is no proof the install is current: the install runs, the marker is replaced and the failure is said", { skip: NO_MODE_RESTRICTIONS }, async () => {
  await withProject(async (p) => {
    installed(p.e2e);
    chmodSync(markerOf(p.e2e), 0o000);
    const { runner, installs } = runnerThat();
    const warnings: string[] = [];
    const warn = mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      await adapterOver(runner).setup(p.e2e);

      assert.equal(installs(), 1);
      assert.equal(readFileSync(markerOf(p.e2e), "utf8"), LOCK_HASH);
      assert.ok(warnings.some((w) => w.includes(markerOf(p.e2e)) && w.includes("EACCES")), `a warning names the marker and the failure's code: ${JSON.stringify(warnings)}`);
    } finally {
      warn.mock.restore();
      rmSync(markerOf(p.e2e), { force: true });
    }
  });
});

test("a marker whose read fails with no code is said by a fixed reason, not by 'undefined' and not by the failure's message, and the install runs", async () => {
  await withProject(async (p) => {
    installed(p.e2e);
    const { runner, installs } = runnerThat();
    const warnings: string[] = [];
    const warn = mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    /* Only the first open fails (the marker's): the lock, read next, opens as it does. */
    const open = mock.method(defaultSpecReadDeps, "open", () => {
      throw new TypeError(`a failure that is not a call's own, quoting ${SECRET_MARK}`);
    }, { times: 1 });
    try {
      await adapterOver(runner).setup(p.e2e);

      assert.equal(installs(), 1);
      const said = warnings.find((w) => w.includes(markerOf(p.e2e)));
      assert.ok(said, JSON.stringify(warnings));
      assert.ok(!said.includes("undefined") && !said.includes(SECRET_MARK), said);
    } finally {
      open.mock.restore();
      warn.mock.restore();
    }
  });
});

test("the marker an install leaves is written through a temporary file, and nothing is left beside it", async () => {
  await withProject(async (p) => {
    writeFileSync(lockOf(p.e2e), LOCK);
    const { runner } = runnerThat(() => mkdirSync(join(p.e2e, "node_modules"), { recursive: true }));

    await adapterOver(runner).setup(p.e2e);

    assert.equal(readFileSync(markerOf(p.e2e), "utf8"), LOCK_HASH);
    assert.deepEqual(temporaryFilesIn(join(p.e2e, "node_modules")), []);
  });
});

test("a link that an install leaves at the marker fails the setup, and the file behind it is not written", async () => {
  await withProject(async (p) => {
    writeFileSync(lockOf(p.e2e), LOCK);
    const { runner } = runnerThat(() => {
      mkdirSync(join(p.e2e, "node_modules"), { recursive: true });
      symlinkSync(p.victim, markerOf(p.e2e));
    });

    await assert.rejects(() => adapterOver(runner).setup(p.e2e), refusedAt(markerOf(p.e2e)));

    assert.equal(readFileSync(p.victim, "utf8"), PRECIOUS, "the hash was not written through the link");
  });
});

test("a marker of exactly the cap is read, and one byte more is removed and the install runs", async () => {
  await withProject(async (p) => {
    const padded = (bytes: number): string => `${LOCK_HASH}${" ".repeat(bytes - LOCK_HASH.length)}`;
    installed(p.e2e, padded(MAX_INSTALL_MARKER_BYTES));
    const exact = runnerThat();
    await adapterOver(exact.runner).setup(p.e2e);
    assert.equal(exact.installs(), 0, "exactly the cap is read, and the install is skipped");

    writeFileSync(markerOf(p.e2e), padded(MAX_INSTALL_MARKER_BYTES + 1));
    const over = runnerThat();
    await capturing(() => adapterOver(over.runner).setup(p.e2e));
    assert.equal(over.installs(), 1, "a marker over the cap says nothing, and the install it was to skip runs");
    assert.equal(readFileSync(markerOf(p.e2e), "utf8"), LOCK_HASH, "and leaves a marker of its own");
  });
});

test("a lock file of exactly the cap is hashed, and one byte more fails the setup", async () => {
  await withProject(async (p) => {
    const sparse = (bytes: number): void => {
      closeSync(openSync(lockOf(p.e2e), "w"));
      truncateSync(lockOf(p.e2e), bytes);
    };
    mkdirSync(join(p.e2e, "node_modules"));
    sparse(MAX_LOCK_FILE_BYTES);
    writeFileSync(markerOf(p.e2e), sha256(Buffer.alloc(MAX_LOCK_FILE_BYTES)));
    const exact = runnerThat();
    await adapterOver(exact.runner).setup(p.e2e);
    assert.equal(exact.installs(), 0, "exactly the cap is hashed, whole");

    sparse(MAX_LOCK_FILE_BYTES + 1);
    const over = runnerThat();
    await assert.rejects(() => adapterOver(over.runner).setup(p.e2e), refusedAt(lockOf(p.e2e)));
    assert.equal(over.installs(), 0);
  });
});

/* ── the fixtures file, the ignore file, the login setup and the Playwright config ─────────────── */

const SEEDED = [
  ["the fixtures file", "fixtures.ts", (a: SetupAdapter, e2e: string) => a.ensureFailureCapture(e2e)],
  ["the ignore file", ".gitignore", (a: SetupAdapter, e2e: string) => a.ensureSessionGitignore(e2e)],
  ["the login setup", "auth.setup.ts", (a: SetupAdapter, e2e: string) => a.ensureAuthSetup(e2e)],
  ["the Playwright config", "playwright.config.ts", (a: SetupAdapter, e2e: string) => a.ensurePlaywrightEnvKeys(e2e)],
] as const;

for (const [what, name, ensure] of SEEDED) {
  test(`${what} that is a named pipe fails the setup and is not waited on, whether it is read or written`, { skip: NO_NAMED_PIPES }, async () => {
    await withProject(async (p) => {
      execFileSync("mkfifo", [join(p.e2e, name)]);

      await withoutWaitingOnNamedPipe(join(p.e2e, name), () => assert.throws(() => ensure(adapterOver(runnerThat().runner), p.e2e), refusedAt(join(p.e2e, name))));
    });
  });

  test(`${what} that is a link fails the setup, and neither the file behind it nor the link is touched`, async () => {
    await withProject(async (p) => {
      symlinkSync(p.victim, join(p.e2e, name));

      assert.throws(() => ensure(adapterOver(runnerThat().runner), p.e2e), refusedAt(join(p.e2e, name)));

      assert.equal(readFileSync(p.victim, "utf8"), PRECIOUS, "nothing was written through the link");
      assert.equal(readFileSync(join(p.e2e, name), "utf8"), PRECIOUS, "the link is still there, pointing at the file");
    });
  });

  test(`${what} that is a directory fails the setup`, async () => {
    await withProject(async (p) => {
      mkdirSync(join(p.e2e, name));

      assert.throws(() => ensure(adapterOver(runnerThat().runner), p.e2e), refusedAt(join(p.e2e, name)));
    });
  });

  test(`${what} larger than a source file's cap fails the setup, and one of exactly the cap is read`, async () => {
    await withProject(async (p) => {
      writeFileSync(join(p.e2e, name), "x".repeat(MAX_SPEC_SOURCE_BYTES + 1));
      assert.throws(() => ensure(adapterOver(runnerThat().runner), p.e2e), refusedAt(join(p.e2e, name)));

      writeFileSync(join(p.e2e, name), "x".repeat(MAX_SPEC_SOURCE_BYTES));
      assert.doesNotThrow(() => ensure(adapterOver(runnerThat().runner), p.e2e));
    });
  });

  test(`a refusal of ${what} names the file and says why, and quotes nothing of what the file it points at holds`, async () => {
    await withProject(async (p) => {
      writeFileSync(join(p.outside, "secret.env"), `${SECRET_MARK}=hunter2`);
      symlinkSync(join(p.outside, "secret.env"), join(p.e2e, name));

      let message = "";
      try {
        ensure(adapterOver(runnerThat().runner), p.e2e);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }

      assert.ok(message.includes(join(p.e2e, name)), `the message names the file: ${message}`);
      assert.ok(message.length > join(p.e2e, name).length + 3, "and says why");
      assert.ok(!message.includes(SECRET_MARK) && !message.includes("hunter2"), "no character of the file behind the link is quoted");
    });
  });
}

/* A fixtures file that names the capture block's marker is the repo's own to keep, whatever else is true of it: setup appends nothing beside a block it did not make whole. */
test("a fixtures file that holds the capture marker without a block it can recognise is left exactly as it is: the marker on the first line, and a block with no end", async () => {
  const cases: Array<[string, string]> = [
    ["the marker on the first line", `// ${FAILURE_CAPTURE_MARKER}\nexport const mine = 1;\n`],
    ["a block that never ends", `export const mine = 1;\n\n// ${FAILURE_CAPTURE_MARKER}\n// captures, and then the file stops\n`],
  ];
  for (const [what, before] of cases) {
    await withProject(async (p) => {
      writeFileSync(join(p.e2e, "fixtures.ts"), before);

      adapterOver(runnerThat().runner).ensureFailureCapture(p.e2e);

      assert.equal(readFileSync(join(p.e2e, "fixtures.ts"), "utf8"), before, what);
    });
  }
});

/* The real copy and the real directory call, which the fakes of setup.adapter.test.ts stand in for. */
test("setup on a directory with no project seeds it, without the seed's node_modules, and makes flows/ for the workers to write in", async () => {
  await withProject(async (p) => {
    rmSync(join(p.e2e, "package.json"));
    const seed = mkdtempSync(join(p.tmp, "seed-"));
    writeFileSync(join(seed, "package.json"), '{"name":"seeded"}');
    writeFileSync(join(seed, "fixtures.ts"), "export const seeded = 1;\n");
    mkdirSync(join(seed, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(seed, "node_modules", "dep", "index.js"), "module.exports = 1;\n");

    await adapterOver(runnerThat().runner, seed).setup(p.e2e);

    assert.equal(readFileSync(join(p.e2e, "package.json"), "utf8"), '{"name":"seeded"}');
    assert.ok(readFileSync(join(p.e2e, "fixtures.ts"), "utf8").startsWith("export const seeded = 1;\n"), "the seed's own file is there");
    assert.equal(existsSync(join(p.e2e, "node_modules", "dep")), false, "the seed's installed packages are not copied");
    assert.equal(statSync(join(p.e2e, "flows")).isDirectory(), true, "flows/ is made");
  });
});

/* A stock copy follows the seed only if there is a seed to follow, and a copy that already is the current seed is not written again. */
test("a stock Playwright config is left as it is when the seed has no config to put in its place", async () => {
  await withProject(async (p) => {
    const stock = shippedRevision("playwright.config.rev1.txt");
    writeFileSync(join(p.e2e, "playwright.config.ts"), stock);
    const emptySeed = mkdtempSync(join(p.tmp, "empty-seed-"));

    assert.doesNotThrow(() => adapterOver(runnerThat().runner, emptySeed).ensurePlaywrightEnvKeys(p.e2e));

    assert.equal(readFileSync(join(p.e2e, "playwright.config.ts"), "utf8"), stock);
  });
});

test("a copy that already is the current seed is not written again, and a stock copy of an earlier revision is replaced by a file of its own", async () => {
  await withProject(async (p) => {
    const path = join(p.e2e, "playwright.config.ts");
    writeFileSync(path, readFileSync(join(REAL_SEED_DIR, "playwright.config.ts"), "utf8"));
    const before = statSync(path).ino;

    adapterOver(runnerThat().runner).ensurePlaywrightEnvKeys(p.e2e);
    assert.equal(statSync(path).ino, before, "the file is the same file: nothing was written");

    writeFileSync(path, shippedRevision("playwright.config.rev1.txt"));
    const stockInode = statSync(path).ino;
    adapterOver(runnerThat().runner).ensurePlaywrightEnvKeys(p.e2e);
    assert.notEqual(statSync(path).ino, stockInode, "the stock copy was replaced by a new file, not written through");
    assert.equal(readFileSync(path, "utf8"), readFileSync(join(REAL_SEED_DIR, "playwright.config.ts"), "utf8"));
  });
});

test("a login setup is given only when the seed has one: a seed directory without it leaves a project without it as it was", async () => {
  await withProject(async (p) => {
    const emptySeed = mkdtempSync(join(p.tmp, "empty-seed-"));

    adapterOver(runnerThat().runner, emptySeed).ensureAuthSetup(p.e2e);

    assert.equal(existsSync(join(p.e2e, "auth.setup.ts")), false);
  });
});

test("a Playwright config of the repo's own is left alone, and the warning names it and the managed keys it lacks, no others", async () => {
  const warningsOf = async (config: string): Promise<{ warnings: string[]; after: string; path: string }> => {
    let seen: { warnings: string[]; after: string; path: string } | undefined;
    await withProject(async (p) => {
      const path = join(p.e2e, "playwright.config.ts");
      writeFileSync(path, config);
      const warnings: string[] = [];
      const warn = mock.method(console, "warn", (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      });
      try {
        adapterOver(runnerThat().runner).ensurePlaywrightEnvKeys(p.e2e);
      } finally {
        warn.mock.restore();
      }
      seen = { warnings, after: readFileSync(path, "utf8"), path };
    });
    return seen!;
  };

  const none = await warningsOf("export default {};\n");
  assert.equal(none.after, "export default {};\n", "the repo's own config is never overwritten");
  assert.equal(none.warnings.length, 1);
  assert.ok(none.warnings[0]!.includes(none.path), "the warning names the file");
  for (const key of ["actionTimeout", "testIdAttribute", "storageState", "PW_AUTH_SETUP"]) assert.ok(none.warnings[0]!.includes(key), `and the key ${key}`);
  assert.match(none.warnings[0]!, /actionTimeout\W+testIdAttribute\W+storageState\W+PW_AUTH_SETUP/, "set apart from one another, in the order they are managed");

  const some = await warningsOf("export default { use: { actionTimeout: 5000, testIdAttribute: 'data-cy' } };\n");
  assert.ok(some.warnings[0]!.includes("storageState") && some.warnings[0]!.includes("PW_AUTH_SETUP"), "it names what is missing");
  assert.ok(!some.warnings[0]!.includes("actionTimeout") && !some.warnings[0]!.includes("testIdAttribute"), "and not what is there");

  const all = await warningsOf("export default { use: { actionTimeout: 1, testIdAttribute: 'a', storageState: 'b' }, projects: process.env.PW_AUTH_SETUP ? [] : [] };\n");
  assert.deepEqual(all.warnings, [], "a config that has every managed key is not warned about");
});

test("the ignore file gets the session directory on a line of its own, whether the file is empty, ends without a newline or has one, and is left alone once the line is there", async () => {
  const cases: Array<[string, string]> = [
    ["", ".auth/\n"],
    ["node_modules/", "node_modules/\n.auth/\n"],
    ["node_modules/\n", "node_modules/\n.auth/\n"],
    [".auth/", ".auth/"],
    ["dist/\n  .auth/  \nout/\n", "dist/\n  .auth/  \nout/\n"],
    ["dist/\n.authors/\n", "dist/\n.authors/\n.auth/\n"],
  ];
  for (const [before, after] of cases) {
    await withProject(async (p) => {
      writeFileSync(join(p.e2e, ".gitignore"), before);

      adapterOver(runnerThat().runner).ensureSessionGitignore(p.e2e);

      assert.equal(readFileSync(join(p.e2e, ".gitignore"), "utf8"), after, JSON.stringify(before));
    });
  }
});

test("what setup replaces in a regular file it replaces whole through a temporary file, and nothing is left beside it", async () => {
  await withProject(async (p) => {
    writeFileSync(join(p.e2e, "fixtures.ts"), "export const test = base.extend({});\n");
    writeFileSync(join(p.e2e, ".gitignore"), "node_modules/\n");

    await adapterOver(runnerThat().runner).setup(p.e2e);

    assert.ok(readFileSync(join(p.e2e, "fixtures.ts"), "utf8").includes(FAILURE_CAPTURE_MARKER), "the capture block is appended");
    assert.ok(readFileSync(join(p.e2e, ".gitignore"), "utf8").split("\n").includes(".auth/"), "the session directory is ignored");
    assert.deepEqual(temporaryFilesIn(p.e2e), [], "no temporary file is left");
  });
});

test("a login setup that is missing is given the current seed, as a regular file", async () => {
  await withProject(async (p) => {
    adapterOver(runnerThat().runner).ensureAuthSetup(p.e2e);

    assert.equal(readFileSync(join(p.e2e, "auth.setup.ts"), "utf8"), readFileSync(join(REAL_SEED_DIR, "auth.setup.ts"), "utf8"));
    assert.deepEqual(temporaryFilesIn(p.e2e), []);
    assert.ok(existsSync(join(p.e2e, "auth.setup.ts")));
  });
});

/* ── the seed copy and flows/ ──────────────────────────────────────────────────────────────────── */

/* A small seed of the shape the real one has: files, a directory of assets (one of them binary) and a node_modules that is never copied. */
function writeSeed(seed: string): void {
  mkdirSync(join(seed, "assets"), { recursive: true });
  mkdirSync(join(seed, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(seed, "package.json"), '{"name":"seed"}');
  writeFileSync(join(seed, "fixtures.ts"), "export const seed = true;\n");
  writeFileSync(join(seed, "assets", "notes.txt"), "a note\n");
  writeFileSync(join(seed, "assets", "photo.bin"), Buffer.from([0, 255, 128, 10, 13, 0, 1]));
  writeFileSync(join(seed, "node_modules", "pkg", "index.js"), "never copied\n");
}

/* An unseeded project: no package.json, so setup copies the seed in. */
async function withUnseededProject(run: (p: Project & { seed: string }) => Promise<void> | void): Promise<void> {
  await withProject((p) => {
    rmSync(join(p.e2e, "package.json"));
    const seed = join(p.tmp, "seed");
    writeSeed(seed);
    return run({ ...p, seed });
  });
}

test("an unseeded project is given the whole seed, byte for byte, except its node_modules", async () => {
  await withUnseededProject(async (p) => {
    const { runner } = runnerThat();

    await capturing(() => adapterOver(runner, p.seed).setup(p.e2e));

    assert.equal(readFileSync(join(p.e2e, "package.json"), "utf8"), '{"name":"seed"}');
    assert.equal(readFileSync(join(p.e2e, "assets", "notes.txt"), "utf8"), "a note\n");
    assert.deepEqual([...readFileSync(join(p.e2e, "assets", "photo.bin"))], [0, 255, 128, 10, 13, 0, 1], "a binary file is copied as it is");
    assert.ok(readFileSync(join(p.e2e, "fixtures.ts"), "utf8").startsWith("export const seed = true;\n"));
    assert.equal(existsSync(join(p.e2e, "node_modules", "pkg")), false, "the seed's node_modules is never copied");
    assert.deepEqual(temporaryFilesIn(p.e2e), []);
    assert.deepEqual(temporaryFilesIn(join(p.e2e, "assets")), []);
  });
});

test("a directory of the project that is a link out of it is not copied into: the seed's files are not written to the directory it points at", async () => {
  await withUnseededProject(async (p) => {
    mkdirSync(join(p.outside, "elsewhere"));
    symlinkSync(join(p.outside, "elsewhere"), join(p.e2e, "assets"));
    const { runner, installs } = runnerThat();

    await assert.rejects(() => adapterOver(runner, p.seed).setup(p.e2e), refusedAt(join(p.e2e, "assets")));

    assert.deepEqual(readdirSync(join(p.outside, "elsewhere")), [], "nothing was written outside the project");
    assert.equal(installs(), 0);
  });
});

test("a directory of the seed with nothing in it is refused all the same where the project has a link: the refusal is of the directory, not of a file below it", async () => {
  await withUnseededProject(async (p) => {
    mkdirSync(join(p.seed, "empty"));
    mkdirSync(join(p.outside, "elsewhere"));
    symlinkSync(join(p.outside, "elsewhere"), join(p.e2e, "empty"));

    await assert.rejects(() => adapterOver(runnerThat().runner, p.seed).setup(p.e2e), refusedAt(join(p.e2e, "empty")));

    assert.deepEqual(readdirSync(join(p.outside, "elsewhere")), []);
    assert.equal(lstatSync(join(p.e2e, "empty")).isSymbolicLink(), true, "the link is as it was");
  });
});

test("a file of the project that is a link out of it fails the setup, and the file it points at is not written", async () => {
  await withUnseededProject(async (p) => {
    symlinkSync(p.victim, join(p.e2e, "fixtures.ts"));

    await assert.rejects(() => adapterOver(runnerThat().runner, p.seed).setup(p.e2e), refusedAt(join(p.e2e, "fixtures.ts")));

    assert.equal(readFileSync(p.victim, "utf8"), PRECIOUS);
  });
});

test("a project directory that is a link is not copied into", async () => {
  await withUnseededProject(async (p) => {
    rmSync(p.e2e, { recursive: true });
    mkdirSync(join(p.outside, "project"));
    symlinkSync(join(p.outside, "project"), p.e2e);

    await assert.rejects(() => adapterOver(runnerThat().runner, p.seed).setup(p.e2e), refusedAt(p.e2e));

    assert.deepEqual(readdirSync(join(p.outside, "project")), []);
  });
});

test("a project directory that is a link is refused as itself when the seed has nothing to copy into it", async () => {
  await withProject(async (p) => {
    rmSync(p.e2e, { recursive: true });
    mkdirSync(join(p.outside, "project"));
    symlinkSync(join(p.outside, "project"), p.e2e);
    const emptySeed = join(p.tmp, "empty-seed");
    mkdirSync(emptySeed);

    await assert.rejects(() => adapterOver(runnerThat().runner, emptySeed).setup(p.e2e), refusedAt(p.e2e));

    assert.deepEqual(readdirSync(join(p.outside, "project")), []);
  });
});

test("a project directory that is not there yet is made and given the seed", async () => {
  await withUnseededProject(async (p) => {
    rmSync(p.e2e, { recursive: true });

    await capturing(() => adapterOver(runnerThat().runner, p.seed).setup(p.e2e));

    assert.equal(readFileSync(join(p.e2e, "package.json"), "utf8"), '{"name":"seed"}');
  });
});

test("flows/ is made when it is not there, and left as it is when it is a directory", async () => {
  await withProject(async (p) => {
    adapterOver(runnerThat().runner).ensureSpecDir(p.e2e);
    writeFileSync(join(p.e2e, "flows", "keep.spec.ts"), "kept");
    adapterOver(runnerThat().runner).ensureSpecDir(p.e2e);

    assert.equal(lstatSync(join(p.e2e, "flows")).isDirectory(), true);
    assert.equal(readFileSync(join(p.e2e, "flows", "keep.spec.ts"), "utf8"), "kept");
  });
});

test("a flows/ that is a link out of the project fails the setup, and nothing is made or written through it", async () => {
  await withProject(async (p) => {
    mkdirSync(join(p.outside, "flows-elsewhere"));
    symlinkSync(join(p.outside, "flows-elsewhere"), join(p.e2e, "flows"));

    assert.throws(() => adapterOver(runnerThat().runner).ensureSpecDir(p.e2e), (err: unknown) => err instanceof ConfinedPathError && err.path === join(p.e2e, "flows") && err.reason !== "");

    assert.equal(lstatSync(join(p.e2e, "flows")).isSymbolicLink(), true, "the link is as it was: it is not setup's to remove");
    assert.deepEqual(readdirSync(join(p.outside, "flows-elsewhere")), []);
  });
});

test("a flows/ that is a named pipe fails the setup, and the pipe is not waited on", { skip: NO_NAMED_PIPES }, async () => {
  await withProject(async (p) => {
    execFileSync("mkfifo", [join(p.e2e, "flows")]);

    await withoutWaitingOnNamedPipe(join(p.e2e, "flows"), () => assert.throws(() => adapterOver(runnerThat().runner).ensureSpecDir(p.e2e), (err: unknown) => err instanceof ConfinedPathError));
  });
});

test("a flows/ that is a regular file fails the setup", async () => {
  await withProject(async (p) => {
    writeFileSync(join(p.e2e, "flows"), "not a directory");

    assert.throws(() => adapterOver(runnerThat().runner).ensureSpecDir(p.e2e), (err: unknown) => err instanceof ConfinedPathError);
  });
});

test("package.json is the last file the seed copy writes: a copy that fails half way leaves a project that is not taken for seeded, and the next setup copies again", async () => {
  await withUnseededProject(async (p) => {
    /* "zz-assets" sorts after "package.json", so a copy that writes the files in the order of their names has written package.json by the time it reaches the link. */
    mkdirSync(join(p.seed, "zz-assets"));
    writeFileSync(join(p.seed, "zz-assets", "notes.txt"), "a note\n");
    mkdirSync(join(p.outside, "elsewhere"));
    symlinkSync(join(p.outside, "elsewhere"), join(p.e2e, "zz-assets"));
    const { runner } = runnerThat();

    await assert.rejects(() => adapterOver(runner, p.seed).setup(p.e2e), refusedAt(join(p.e2e, "zz-assets")));
    const left = existsSync(join(p.e2e, "package.json"));
    rmSync(join(p.e2e, "zz-assets"));
    await capturing(() => adapterOver(runner, p.seed).setup(p.e2e));

    assert.equal(left, false, "a project with a package.json looks seeded to every later setup, which would never copy the rest");
    assert.equal(readFileSync(join(p.e2e, "zz-assets", "notes.txt"), "utf8"), "a note\n", "and with the link gone the next setup copies it all");
    assert.equal(readFileSync(join(p.e2e, "package.json"), "utf8"), '{"name":"seed"}');
  });
});

/* ── what a run leaves in .qa ──────────────────────────────────────────────────────────────────── */

/* `.qa/coverage`, `.qa/fault-injection` and `.qa/measured.json` are the orchestrator's, made by the runs, and the project's .gitignore keeps git from cleaning them, so what the agent plants there outlives the run: a link or a named pipe in the place of a directory refuses the strict read of every dump or counter that a later run leaves in it, and the coverage and the score are unknown for good. Setup removes what is not an ordinary directory (or file) there, without opening it or following it, and says so. */
const qaPath = (e2e: string, name: string): string => join(e2e, ".qa", name);

test("a link where the coverage directory belongs is removed by setup, never followed, and said aloud, so the next run can make the directory again", async () => {
  await withProject(async (p) => {
    installed(p.e2e);
    mkdirSync(join(p.outside, "elsewhere", "ns"), { recursive: true });
    writeFileSync(join(p.outside, "elsewhere", "ns", "dump.json"), "[]");
    mkdirSync(join(p.e2e, ".qa"));
    symlinkSync(join(p.outside, "elsewhere"), qaPath(p.e2e, "coverage"));

    const { warnings } = await capturing(() => adapterOver(runnerThat().runner).setup(p.e2e));

    assert.throws(() => lstatSync(qaPath(p.e2e, "coverage")), (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT", "the link is gone");
    assert.equal(readFileSync(join(p.outside, "elsewhere", "ns", "dump.json"), "utf8"), "[]", "and what it pointed at is as it was");
    assert.ok(warnings.some((w) => w.includes(qaPath(p.e2e, "coverage"))), `the removal is said, with the path: ${JSON.stringify(warnings)}`);
  });
});

test("a named pipe where the fault-injection directory belongs is removed by setup without being opened or waited on", { skip: NO_NAMED_PIPES }, async () => {
  await withProject(async (p) => {
    installed(p.e2e);
    mkdirSync(join(p.e2e, ".qa"));
    execFileSync("mkfifo", [qaPath(p.e2e, "fault-injection")]);

    const { warnings } = await capturing(() => withoutWaitingOnNamedPipe(qaPath(p.e2e, "fault-injection"), () => adapterOver(runnerThat().runner).setup(p.e2e)));

    assert.throws(() => lstatSync(qaPath(p.e2e, "fault-injection")), (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT");
    assert.ok(warnings.some((w) => w.includes(qaPath(p.e2e, "fault-injection"))));
  });
});

test("a link or a directory where the measured file belongs is removed or set aside, and what a link pointed at is not touched", async () => {
  await withProject(async (p) => {
    installed(p.e2e);
    mkdirSync(join(p.e2e, ".qa"));
    symlinkSync(p.victim, qaPath(p.e2e, "measured.json"));

    await capturing(() => adapterOver(runnerThat().runner).setup(p.e2e));
    const afterLink = existsSync(qaPath(p.e2e, "measured.json"));
    mkdirSync(qaPath(p.e2e, "measured.json"));
    await capturing(() => adapterOver(runnerThat().runner).setup(p.e2e));

    assert.equal(afterLink, false);
    assert.equal(existsSync(qaPath(p.e2e, "measured.json")), false, "a directory is set aside beside where it was");
    assert.ok(readdirSync(join(p.e2e, ".qa")).some((name) => name.startsWith("measured.json.refused-")));
    assert.equal(readFileSync(p.victim, "utf8"), PRECIOUS);
  });
});

test("ordinary directories and an ordinary measured file are left exactly as they are, with what is in them, and setup says nothing of them", async () => {
  await withProject(async (p) => {
    installed(p.e2e);
    mkdirSync(join(p.e2e, ".qa", "coverage", "ns"), { recursive: true });
    mkdirSync(join(p.e2e, ".qa", "fault-injection", "ns"), { recursive: true });
    writeFileSync(join(p.e2e, ".qa", "coverage", "ns", "dump.json"), "[]");
    writeFileSync(qaPath(p.e2e, "measured.json"), '{"stability":1}');

    const { warnings } = await capturing(() => adapterOver(runnerThat().runner).setup(p.e2e));

    assert.equal(readFileSync(join(p.e2e, ".qa", "coverage", "ns", "dump.json"), "utf8"), "[]");
    assert.equal(readFileSync(qaPath(p.e2e, "measured.json"), "utf8"), '{"stability":1}');
    assert.deepEqual(readdirSync(join(p.e2e, ".qa")).sort(), ["coverage", "fault-injection", "measured.json"], "and nothing is made beside them");
    assert.deepEqual(warnings.filter((w) => w.includes(".qa")), []);
  });
});

test("a project with no .qa has nothing to remove and setup makes nothing of it", async () => {
  await withProject(async (p) => {
    installed(p.e2e);

    await capturing(() => adapterOver(runnerThat().runner).setup(p.e2e));

    assert.equal(existsSync(join(p.e2e, ".qa")), false);
  });
});

test("an entry that cannot be removed does not fail the setup, since what it protects is a signal: it is said aloud with the failure's code and nothing else", async () => {
  await withProject(async (p) => {
    installed(p.e2e);
    mkdirSync(join(p.e2e, ".qa"));
    symlinkSync(p.victim, qaPath(p.e2e, "coverage"));
    const denied = (): never => { throw Object.assign(new Error(`denied ${SECRET_MARK}`), { code: "EPERM" }); };
    const fs = { ...nodeFsDeps, purgeRefusedDirectory: denied };
    const adapter = new SetupAdapter({ fs, runner: runnerThat().runner, seedDir: REAL_SEED_DIR });

    const { warnings } = await capturing(() => adapter.setup(p.e2e));

    assert.equal(lstatSync(qaPath(p.e2e, "coverage")).isSymbolicLink(), true, "it is still there");
    const said = warnings.filter((w) => w.includes(qaPath(p.e2e, "coverage")));
    assert.ok(said.length >= 1 && said.every((w) => w.includes("EPERM") && !w.includes(SECRET_MARK)), `said by its code, quoting nothing of the failure: ${JSON.stringify(said)}`);
  });
});

test("a project directory that is itself a link has nothing removed from the directory it points at", async () => {
  await withProject(async (p) => {
    mkdirSync(join(p.outside, "project", ".qa"), { recursive: true });
    writeFileSync(join(p.outside, "project", "package.json"), "{}");
    symlinkSync(p.victim, join(p.outside, "project", ".qa", "coverage"));
    rmSync(p.e2e, { recursive: true });
    symlinkSync(join(p.outside, "project"), p.e2e);

    await assert.rejects(() => adapterOver(runnerThat().runner).setup(p.e2e));

    assert.equal(lstatSync(join(p.outside, "project", ".qa", "coverage")).isSymbolicLink(), true, "nothing was removed behind the link");
  });
});
