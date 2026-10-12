/* The boot check starts its probing child the way the launcher starts agent code, and with nothing the sandbox uid could have prepared. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { probeSpawnFor, writeStatus } from "./file-boundary-check";

const SANDBOX = { uid: 1002, gid: 1002, home: "/home/sandbox" };
const PLAN = [{ kind: "read" as const, path: "/app/data/.api_token" }, { kind: "write" as const, path: "/app/src" }];

test("the probing child runs the probe script with the plain node binary: no loader, no import hook, no flag of the parent's", () => {
  assert.ok(process.execArgv.length > 0, "this test runs under a loader, which the child must not inherit");
  const { command, args } = probeSpawnFor(SANDBOX, PLAN, { PATH: "/usr/bin" });
  assert.equal(command, process.execPath);
  assert.equal(args.length, 1);
  assert.equal(basename(args[0]!), "file-boundary-probe.mjs");
  assert.ok(!args.some((a) => a.startsWith("-")), args.join(" "));
});

test("the probing child gets the sandbox identity, an environment of PATH alone and the plan on stdin", () => {
  const { options } = probeSpawnFor(SANDBOX, PLAN, { PATH: "/usr/bin", TMPDIR: "/tmp/planted", NODE_OPTIONS: "--require /tmp/x.js", HOME: "/root" });
  assert.equal(options.uid, SANDBOX.uid);
  assert.equal(options.gid, SANDBOX.gid);
  assert.equal(options.cwd, "/");
  assert.deepEqual(options.env, { PATH: "/usr/bin" });
  assert.deepEqual(JSON.parse(String(options.input)), PLAN);
});

test("the status is written through a new file of an unpredictable name, never through a link planted at a predictable one", () => {
  const dir = mkdtempSync(join(tmpdir(), "boundary-status-"));
  try {
    const elsewhere = join(dir, "elsewhere");
    writeFileSync(elsewhere, "untouched");
    const status = join(dir, "status");
    /* what a write through the old name `.<pid>.file-boundary.tmp` would have followed */
    symlinkSync(elsewhere, join(dir, `.${process.pid}.file-boundary.tmp`));
    writeStatus(status, "ok\n");
    assert.equal(readFileSync(status, "utf8"), "ok\n");
    assert.equal(readFileSync(elsewhere, "utf8"), "untouched");
    assert.equal(statSync(status).mode & 0o777, 0o644);
    writeStatus(status, "breach: x\n");
    assert.equal(readFileSync(status, "utf8"), "breach: x\n");
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp") && !lstatSync(join(dir, f)).isSymbolicLink()), [], "no temporary file is left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the status temporary file is created exclusively: an existing file of that name stops the write instead of being written through", () => {
  const dir = mkdtempSync(join(tmpdir(), "boundary-status-"));
  try {
    const status = join(dir, "status");
    writeFileSync(join(dir, ".x.file-boundary.tmp"), "planted");
    assert.throws(() => writeStatus(status, "ok\n", () => "x"), /EEXIST/);
    assert.equal(readFileSync(join(dir, ".x.file-boundary.tmp"), "utf8"), "planted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
