/* The per-run directory the sandboxed children write into, and the private copies of the session they read. The sandbox uid owns this directory and nothing else in the container: Playwright's output, its report, the failure dumps, the login's session file and the temp dir all live here, and the orchestrator reads them back through the strict readers because the child can plant a link, a pipe or an oversized file under any name. The orchestrator's own auth directory is never opened to the child: a suite sees a fresh copy, restored for every spawn, so a spec that rewrites its session cannot change the one the next spawn starts from. */

import { chownSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readOwnedSpecFile } from "../spec-path-confinement.ts";
import { activeRunSecretScope } from "../../shared-kernel/run-secret-redaction.ts";
import { AUTH_MATERIAL_FILES } from "./auth-session-env.ts";
import type { StagedAuth } from "./exec-env.ts";
import type { Sandbox } from "./sandbox.ts";

/* Subdirectories a child may write to. `scripts` is not among them: it is written by the orchestrator (a reporter, a login script) and only read by the child. */
const WRITABLE_SUBDIRS = ["tmp", "home", "results", "report", "failures", "login", "auth"] as const;
const ROOT_OWNED_SUBDIRS = ["scripts"] as const;

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const MAX_STORAGE_STATE_BYTES = 4 * 1024 * 1024;
const MAX_CLIENT_CERT_BYTES = 1024 * 1024;
const MAX_CERT_PASS_BYTES = 4096;

function chownTo(path: string, sandbox: Sandbox | null): void {
  if (sandbox) chownSync(path, sandbox.uid, sandbox.gid);
}

/* Creates `<root>/<runId>` with its subdirectories, owned by the sandbox and closed to everyone else. An earlier directory of the same id is removed first: nothing a previous run left is visible to this one. */
export function openRunWorkDir(root: string, runId: string, sandbox: Sandbox | null): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`invalid run id ${JSON.stringify(runId)} for a work dir: must match ${String(RUN_ID_RE)}`);
  mkdirSync(root, { recursive: true, mode: 0o711 });
  const dir = join(root, runId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  chownTo(dir, sandbox);
  for (const sub of WRITABLE_SUBDIRS) {
    const path = join(dir, sub);
    mkdirSync(path, { mode: 0o700 });
    chownTo(path, sandbox);
  }
  for (const sub of ROOT_OWNED_SUBDIRS) {
    const path = join(dir, sub);
    mkdirSync(path, { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  return dir;
}

/* Removes the directory and what is in it, never following a link out of it. */
export function removeRunWorkDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function readStrict(authDir: string, name: string, maxBytes: number): Buffer | undefined {
  let read;
  try {
    read = readOwnedSpecFile({ mirrorDir: authDir, specDir: authDir }, name, maxBytes);
  } catch {
    return undefined;
  }
  return "bytes" in read ? read.bytes : undefined;
}

function copyInto(dir: string, name: string, bytes: Buffer, sandbox: Sandbox | null): string {
  const target = join(dir, "auth", name);
  rmSync(target, { force: true });
  writeFileSync(target, bytes, { mode: 0o400 });
  chmodSync(target, 0o400);
  chownTo(target, sandbox);
  return target;
}

/* Copies the saved session and the client certificate from the orchestrator-only `authDir` into the run's `auth/` folder, freshly each time, and returns the copies' paths. Material that is absent, a link, a pipe or oversized is not staged. */
export function stageAuthMaterial(authDir: string | undefined, workDir: string, sandbox: Sandbox | null): StagedAuth {
  if (authDir === undefined) return {};
  const staged: StagedAuth = {};
  const session = readStrict(authDir, AUTH_MATERIAL_FILES.storageState, MAX_STORAGE_STATE_BYTES);
  if (session) staged.storageState = copyInto(workDir, AUTH_MATERIAL_FILES.storageState, session, sandbox);
  const cert = readStrict(authDir, AUTH_MATERIAL_FILES.clientCert, MAX_CLIENT_CERT_BYTES);
  if (cert) {
    staged.clientCert = copyInto(workDir, AUTH_MATERIAL_FILES.clientCert, cert, sandbox);
    const pass = readStrict(authDir, AUTH_MATERIAL_FILES.certPass, MAX_CERT_PASS_BYTES);
    if (pass) staged.certPass = pass.toString("utf8");
  }
  /* What a spec could print of this material, raw or encoded, is taken out of anything a tool answers with: the run's secret scope holds the bytes (a no-op outside a run). */
  activeRunSecretScope()?.addOpaqueBytes([session, cert]);
  return staged;
}

/* A fresh directory inside the work dir for one call (one Playwright run, one capture), with the subdirectories the call writes into, all owned by the sandbox. Each call gets its own so that what an earlier call left, a failure dump or a report, is never read as this call's. */
export function allocWorkSubdir(workDir: string, prefix: string, subdirs: readonly string[], sandbox: Sandbox | null): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(prefix)) throw new Error(`invalid work subdirectory prefix ${JSON.stringify(prefix)}`);
  const dir = mkdtempSync(join(workDir, `${prefix}-`));
  chmodSync(dir, 0o700);
  chownTo(dir, sandbox);
  for (const sub of subdirs) {
    const path = join(dir, sub);
    mkdirSync(path, { mode: 0o700 });
    chownTo(path, sandbox);
  }
  return dir;
}

/* A script authored by the orchestrator (a reporter, a login or capture script), written where the sandbox can read it and cannot change it: the file is root-owned and read-only, in the work dir's `scripts` folder. */
export function writeWorkScript(workDir: string, name: string, content: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error(`invalid script name ${JSON.stringify(name)}`);
  const path = join(workDir, "scripts", `${randomBytes(6).toString("hex")}-${name}`);
  writeFileSync(path, content, { mode: 0o444 });
  chmodSync(path, 0o444);
  return path;
}
