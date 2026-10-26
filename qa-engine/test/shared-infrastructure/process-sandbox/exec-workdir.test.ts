/* A run's sandboxed children write only inside one directory made for the run, and see a private copy of the session, never the orchestrator's own auth directory. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRunWorkDir, removeRunWorkDir, stageAuthMaterial } from "../../../src/shared-infrastructure/process-sandbox/exec-workdir.ts";
import { AUTH_MATERIAL_FILES } from "../../../src/shared-infrastructure/process-sandbox/auth-session-env.ts";
import { createRunSecretScope, withRunSecretScope } from "../../../src/shared-infrastructure/redaction/run-secret-redaction.ts";

const SELF = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, home: "/home/sandbox" };

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "exec-workdir-"));
}

test("a run's work dir holds the folders its children write into, private to the owner", () => {
  const root = scratch();
  try {
    const dir = openRunWorkDir(root, "run-abc", SELF);
    assert.equal(dir, join(root, "run-abc"));
    for (const sub of ["tmp", "results", "report", "failures", "login", "auth"]) assert.equal(statSync(join(dir, sub)).isDirectory(), true, sub);
    assert.equal(statSync(dir).mode & 0o077, 0, "the work dir is not readable by anyone else");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opening the work dir of a run discards what an earlier run of the same id left", () => {
  const root = scratch();
  try {
    const dir = openRunWorkDir(root, "run-1", null);
    writeFileSync(join(dir, "report", "stale.json"), "old");
    openRunWorkDir(root, "run-1", null);
    assert.equal(existsSync(join(dir, "report", "stale.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run id that could leave the root is refused", () => {
  const root = scratch();
  try {
    for (const bad of ["../x", "a/b", "", ".", "..", "x\0y", "-rf"]) assert.throws(() => openRunWorkDir(root, bad, null), /run id/i, bad);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removing a work dir removes everything the children left, links included, without following them", () => {
  const root = scratch();
  const outside = scratch();
  try {
    const dir = openRunWorkDir(root, "run-2", null);
    writeFileSync(join(outside, "keep.txt"), "keep");
    symlinkSync(outside, join(dir, "results", "link"));
    removeRunWorkDir(dir);
    assert.equal(existsSync(dir), false);
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("staging copies the session, the certificate and its passphrase into the work dir and hands back those paths", () => {
  const root = scratch();
  const authDir = scratch();
  try {
    writeFileSync(join(authDir, AUTH_MATERIAL_FILES.storageState), '{"cookies":[]}');
    writeFileSync(join(authDir, AUTH_MATERIAL_FILES.clientCert), "p12-bytes");
    writeFileSync(join(authDir, AUTH_MATERIAL_FILES.certPass), "the-pass");
    const dir = openRunWorkDir(root, "run-3", null);
    const staged = stageAuthMaterial(authDir, dir, null);
    assert.equal(staged.storageState?.startsWith(dir), true);
    assert.equal(readFileSync(staged.storageState!, "utf8"), '{"cookies":[]}');
    assert.equal(readFileSync(staged.clientCert!, "utf8"), "p12-bytes");
    assert.equal(staged.certPass, "the-pass");
    chmodSync(staged.storageState!, 0o600);
    writeFileSync(staged.storageState!, "tampered");
    assert.equal(readFileSync(join(authDir, AUTH_MATERIAL_FILES.storageState), "utf8"), '{"cookies":[]}', "the orchestrator's session is a separate file");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
  }
});

test("staging restores a session a spec tampered with, and finds nothing to stage when there is no session", () => {
  const root = scratch();
  const authDir = scratch();
  try {
    const dir = openRunWorkDir(root, "run-4", null);
    assert.deepEqual(stageAuthMaterial(authDir, dir, null), {});
    assert.deepEqual(stageAuthMaterial(undefined, dir, null), {});
    writeFileSync(join(authDir, AUTH_MATERIAL_FILES.storageState), "good");
    const first = stageAuthMaterial(authDir, dir, null);
    chmodSync(first.storageState!, 0o600);
    writeFileSync(first.storageState!, "bad");
    const second = stageAuthMaterial(authDir, dir, null);
    assert.equal(readFileSync(second.storageState!, "utf8"), "good");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
  }
});

test("a session file that is a link is not staged", () => {
  const root = scratch();
  const authDir = scratch();
  const elsewhere = scratch();
  try {
    writeFileSync(join(elsewhere, "secret"), "do-not-copy");
    symlinkSync(join(elsewhere, "secret"), join(authDir, AUTH_MATERIAL_FILES.storageState));
    const dir = openRunWorkDir(root, "run-5", null);
    const staged = stageAuthMaterial(authDir, dir, null);
    assert.equal(staged.storageState, undefined);
    assert.equal(existsSync(join(dir, "auth", AUTH_MATERIAL_FILES.storageState)), false);
  } finally {
    for (const d of [root, authDir, elsewhere]) rmSync(d, { recursive: true, force: true });
  }
});

test("a root that does not exist yet is created with its parents", () => {
  const base = scratch();
  try {
    const root = join(base, "a", "b");
    mkdirSync(root, { recursive: true });
    assert.equal(statSync(openRunWorkDir(root, "run-6", null)).isDirectory(), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("staging registers the session file and the certificate bytes as secrets of the run, so a spec that prints them encoded is redacted", () => {
  const root = scratch();
  const authDir = scratch();
  try {
    const session = '{"cookies":[{"name":"sid","value":"abcdef0123456789"}],"origins":[]}';
    const cert = Buffer.from("binary-pkcs12-material-\u0001\u0002\u0003-0123456789abcdef");
    writeFileSync(join(authDir, AUTH_MATERIAL_FILES.storageState), session);
    writeFileSync(join(authDir, AUTH_MATERIAL_FILES.clientCert), cert);
    const dir = openRunWorkDir(root, "run-5", null);
    const scope = createRunSecretScope();
    withRunSecretScope(scope, () => stageAuthMaterial(authDir, dir, null));
    for (const leaked of [Buffer.from(session).toString("base64"), Buffer.from(session).toString("hex"), cert.toString("base64"), cert.toString("base64url")]) {
      assert.doesNotMatch(scope.redact(`out ${leaked} out`), new RegExp(leaked.slice(0, 16).replace(/[+/]/g, "\\$&")), leaked.slice(0, 12));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(authDir, { recursive: true, force: true });
  }
});
