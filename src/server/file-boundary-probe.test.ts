/* The probing child of the boot check is plain JavaScript run by the sandbox uid: it reports only what each system call answered. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeProbe, observeProbes, type ProbeOps } from "./file-boundary-probe.mjs";

const SCRIPT = join(import.meta.dirname, "file-boundary-probe.mjs");

function fakeOps(failures: Record<string, string> = {}, kinds: Record<string, "dir" | "file" | "other"> = {}): ProbeOps & { created: string[]; opened: string[] } {
  const created: string[] = [];
  const opened: string[] = [];
  const fail = (path: string): void => {
    const code = failures[path];
    if (code) throw Object.assign(new Error(`no ${path}`), { code });
  };
  return {
    created,
    opened,
    readFile: fail,
    list: fail,
    kind: (path) => {
      fail(path);
      return kinds[path] ?? "dir";
    },
    createIn: (dir) => {
      fail(dir);
      created.push(dir);
    },
    openForWrite: (path) => {
      fail(path);
      opened.push(path);
    },
  };
}

test("a read or a list is reported as the error code it ended with, null when it worked", () => {
  const ops = fakeOps({ "/secret": "EACCES", "/gone": "ENOENT" });
  assert.deepEqual(observeProbe({ kind: "read", path: "/secret" }, ops), { code: "EACCES" });
  assert.deepEqual(observeProbe({ kind: "list", path: "/gone" }, ops), { code: "ENOENT" });
  assert.deepEqual(observeProbe({ kind: "list", path: "/open" }, ops), { code: null });
});

test("a write creates a file in a directory and opens a file for writing, and tries nothing on anything else", () => {
  const ops = fakeOps({}, { "/dir": "dir", "/file": "file", "/pipe": "other" });
  const seen = observeProbes([{ kind: "write", path: "/dir" }, { kind: "write", path: "/file" }, { kind: "write", path: "/pipe" }], ops);
  assert.deepEqual(seen, [{ kind: "dir", code: null }, { kind: "file", code: null }, { kind: "other", code: null }]);
  assert.deepEqual(ops.created, ["/dir"]);
  assert.deepEqual(ops.opened, ["/file"]);
});

test("a write to a path that cannot be examined reports that failure and no kind; a refused attempt keeps the kind it found", () => {
  const ops = fakeOps({ "/missing": "ENOENT" });
  assert.deepEqual(observeProbe({ kind: "write", path: "/missing" }, ops), { code: "ENOENT" });
  const ro = fakeOps({}, { "/ro": "dir" });
  ro.createIn = () => {
    throw Object.assign(new Error("read-only"), { code: "EROFS" });
  };
  assert.deepEqual(observeProbe({ kind: "write", path: "/ro" }, ro), { kind: "dir", code: "EROFS" });
});

function run(stdin: string): { status: number | null; stdout: string } {
  const child = spawnSync(process.execPath, [SCRIPT], { input: stdin, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  return { status: child.status, stdout: child.stdout };
}

test("run as a program on real paths it prints one observation per planned attempt and leaves nothing behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "boundary-probe-"));
  try {
    writeFileSync(join(dir, "file"), "x");
    const plan = [
      { kind: "write", path: dir },
      { kind: "write", path: join(dir, "file") },
      { kind: "read", path: join(dir, "absent") },
      { kind: "list", path: dir },
    ];
    const { status, stdout } = run(JSON.stringify(plan));
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(stdout), [{ kind: "dir", code: null }, { kind: "file", code: null }, { code: "ENOENT" }, { code: null }]);
    assert.deepEqual(readdirSync(dir), ["file"], "the file it created is gone again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run as a program against a directory it may not write it reports the refusal", { skip: process.getuid?.() === 0 ? "root is not refused" : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), "boundary-probe-"));
  const closed = join(dir, "closed");
  try {
    mkdirSync(closed);
    chmodSync(closed, 0o500);
    const { stdout } = run(JSON.stringify([{ kind: "write", path: closed }]));
    assert.deepEqual(JSON.parse(stdout), [{ kind: "dir", code: "EACCES" }]);
    assert.equal(existsSync(closed), true);
  } finally {
    chmodSync(closed, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plan that is not a list of attempts makes the program fail instead of printing a report", () => {
  for (const input of ["", "not json", "{}"]) {
    const { status, stdout } = run(input);
    assert.notEqual(status, 0, input);
    assert.equal(stdout, "", input);
  }
});
