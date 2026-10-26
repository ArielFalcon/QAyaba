/* The control-plane API token when QA_API_TOKEN does not pin one: generated once and kept in the data directory (the qayaba-data volume in the container), which is closed to the sandbox uid on every filesystem because it is a volume and not a host folder. */

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export function apiTokenPath(root: string): string {
  return join(root, "data", ".api_token");
}

function readToken(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/* What a client on the same machine authenticates with: QA_API_TOKEN, else the service's file. Never writes. */
export function discoverApiToken(env: Record<string, string | undefined>, root: string): string | undefined {
  if (env.QA_API_TOKEN) return env.QA_API_TOKEN;
  return readToken(apiTokenPath(root));
}

export interface ApiTokenDeps {
  log?: (line: string) => void;
}

const STALE_TEMPORARY = /^\.api_token\.\d+\.tmp$/;

/* The files a start that crashed between writing and renaming left beside the token: a token value in a file nothing refers to. */
function sweepStaleTemporaries(dataDir: string): void {
  for (const name of readdirSync(dataDir)) if (STALE_TEMPORARY.test(name)) unlinkSync(join(dataDir, name));
}

/* The token the service authenticates with when QA_API_TOKEN is unset: the data directory's, else a new one. The file is owner-only. */
export function loadOrCreateApiToken(root: string, deps: ApiTokenDeps = {}): string {
  const log = deps.log ?? ((line: string): void => console.log(line));
  const path = apiTokenPath(root);
  mkdirSync(join(root, "data"), { recursive: true, mode: 0o700 });
  chmodSync(join(root, "data"), 0o700);
  sweepStaleTemporaries(join(root, "data"));

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

/* The token the service authenticates with: QA_API_TOKEN when it pins one, else the data directory's. */
export function resolveApiToken(env: Record<string, string | undefined>, root: string, deps: ApiTokenDeps = {}): string {
  return env.QA_API_TOKEN || loadOrCreateApiToken(root, deps);
}
