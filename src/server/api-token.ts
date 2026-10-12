/* The control-plane API token when QA_API_TOKEN does not pin one: generated once and kept in the data directory (the qa-data volume in the container), which is closed to the sandbox uid on every filesystem because it is a volume and not a host folder. It used to live in config/, a host bind mount, where a filesystem that does not enforce permissions (Docker Desktop's file sharing) handed it to any uid: a token found there is moved, once, and no copy is left behind. */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export function apiTokenPath(root: string): string {
  return join(root, "data", ".api_token");
}

/* Where an earlier version kept it. Read only to move it, or by a client talking to such a version. */
export function legacyApiTokenPath(root: string): string {
  return join(root, "config", ".api_token");
}

function readToken(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/* What a client on the same machine authenticates with: QA_API_TOKEN, else the service's file, else the file of an earlier version. Never writes. */
export function discoverApiToken(env: Record<string, string | undefined>, root: string): string | undefined {
  if (env.QA_API_TOKEN) return env.QA_API_TOKEN;
  return readToken(apiTokenPath(root)) ?? readToken(legacyApiTokenPath(root));
}

function removeLegacy(path: string, log: (line: string) => void): void {
  try {
    unlinkSync(path);
  } catch (err) {
    console.error(`[qa] ERROR: the old API token file ${path} could not be removed (${err instanceof Error ? err.message : String(err)}); remove it by hand, a copy of the token must not stay with the app configs.`);
    return;
  }
  log(`[qa] removed the old API token file ${path}`);
}

/* The token the service authenticates with when QA_API_TOKEN is unset: the data directory's, else the one an earlier version left in config/ (moved), else a new one. The file is owner-only. */
export function loadOrCreateApiToken(root: string, deps: { log?: (line: string) => void } = {}): string {
  const log = deps.log ?? ((line: string): void => console.log(line));
  const path = apiTokenPath(root);
  const legacy = legacyApiTokenPath(root);
  mkdirSync(join(root, "data"), { recursive: true, mode: 0o700 });
  chmodSync(join(root, "data"), 0o700);

  const current = readToken(path);
  if (current) {
    chmodSync(path, 0o600);
    if (existsSync(legacy)) removeLegacy(legacy, log);
    return current;
  }

  const moved = readToken(legacy);
  const token = moved ?? randomBytes(32).toString("hex");
  /* Written whole beside the target and renamed over it, so a crash never leaves a half token the next boot would take. */
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, token, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  if (moved) {
    removeLegacy(legacy, log);
    log(`[qa] moved the API token from ${legacy} to ${path}`);
  } else {
    log(`[qa] auto-generated QA_API_TOKEN → ${path}`);
  }
  return token;
}
