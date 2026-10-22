/* The control-plane API token when QA_API_TOKEN does not pin one: generated once and kept in the data directory (the qa-data volume in the container), which is closed to the sandbox uid on every filesystem because it is a volume and not a host folder. It used to live in config/, a host bind mount, where a filesystem that does not enforce permissions (Docker Desktop's file sharing) handed it to any uid: whatever sat there may have been read, so it is never reused. A token found there is removed (a new one takes its place) and a file that cannot be removed stops the start. */

import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export function apiTokenPath(root: string): string {
  return join(root, "data", ".api_token");
}

/* Where an earlier version kept it. Never trusted by the service (it is removed at start); read only by a client talking to such a version. */
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

export interface ApiTokenDeps {
  log?: (line: string) => void;
  /* Removes a file; throws the call's error. */
  remove?: (path: string) => void;
}

/* The file an earlier version kept in config/ goes, whatever the token that is pinned or generated now: it may have been readable by the sandbox uid, so its value counts as exposed and is never used again. A copy that cannot be removed stops the start, as a setting that is wrong does (the service refuses to compose with it): serving on while a possibly exposed token sits in the host folder is the state this removal exists to end. The notice names files, never values. */
export function retireLegacyApiToken(root: string, deps: ApiTokenDeps = {}): void {
  const log = deps.log ?? ((line: string): void => console.log(line));
  const remove = deps.remove ?? unlinkSync;
  const legacy = legacyApiTokenPath(root);
  try {
    lstatSync(legacy);
  } catch {
    return;
  }
  try {
    remove(legacy);
  } catch (err) {
    throw new Error(`the old API token file ${legacy} could not be removed (${err instanceof Error ? err.message : String(err)}); remove it by hand: a token that was kept in the host's config folder may have been read by agent code, and the service does not start while a copy sits there`);
  }
  log(`[qa] removed the old API token file ${legacy}: it was kept where agent code may have read it, so its value is retired. The token is now QA_API_TOKEN when set, else ${apiTokenPath(root)}; clients (the TUI, scripts) must discover it again`);
}

const STALE_TEMPORARY = /^\.api_token\.\d+\.tmp$/;

/* The files a start that crashed between writing and renaming left beside the token: a token value in a file nothing refers to. */
function sweepStaleTemporaries(dataDir: string): void {
  for (const name of readdirSync(dataDir)) if (STALE_TEMPORARY.test(name)) unlinkSync(join(dataDir, name));
}

/* The token the service authenticates with when QA_API_TOKEN is unset: the data directory's, else a new one (an earlier version's file in config/ is removed, never reused). The file is owner-only. */
export function loadOrCreateApiToken(root: string, deps: ApiTokenDeps = {}): string {
  const log = deps.log ?? ((line: string): void => console.log(line));
  const path = apiTokenPath(root);
  mkdirSync(join(root, "data"), { recursive: true, mode: 0o700 });
  chmodSync(join(root, "data"), 0o700);
  sweepStaleTemporaries(join(root, "data"));
  retireLegacyApiToken(root, deps);

  const current = readToken(path);
  if (current) {
    chmodSync(path, 0o600);
    return current;
  }

  const token = randomBytes(32).toString("hex");
  /* Written whole beside the target and renamed over it, so a crash never leaves a half token the next boot would take. */
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, token, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  log(`[qa] auto-generated QA_API_TOKEN → ${path}`);
  return token;
}

/* The token the service authenticates with: QA_API_TOKEN when it pins one, else the data directory's. Either way the old file in config/ goes. */
export function resolveApiToken(env: Record<string, string | undefined>, root: string, deps: ApiTokenDeps = {}): string {
  if (!env.QA_API_TOKEN) return loadOrCreateApiToken(root, deps);
  retireLegacyApiToken(root, deps);
  return env.QA_API_TOKEN;
}
