/*
 * Version/capability handshake. Unauthenticated so a stale client can be told to update
 * even with a wrong token. The server owns compatibility policy.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { VersionInfo } from "../entrypoints/contract/commands";

export const WIRE_API_VERSION = "v1";

export const MIN_CLIENT_VERSION = "0.1.0";

export const CAPABILITIES = [
  "runs", "run-events-sse", "ask", "continue", "cancel",
  "queue", "apps", "repos", "agent-runtime", "history",
] as const;

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SERVER_VERSION = readServerVersion();

function readServerVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const COMMIT_ID = /^[0-9a-f]{40}$/;

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/* The git directory of a checkout: `.git` itself, or the one a linked worktree's `.git` file points at. */
function gitDirOf(root: string): string | null {
  const dot = join(root, ".git");
  try {
    if (statSync(dot).isDirectory()) return dot;
  } catch {
    return null;
  }
  const pointer = readText(dot)?.match(/^gitdir:\s*(.+)$/)?.[1];
  return pointer ? (isAbsolute(pointer) ? pointer : resolve(root, pointer)) : null;
}

/* The commit a ref names, from its loose file or the packed refs, in the common directory a linked worktree shares. */
function commitOfRef(gitDir: string, ref: string): string | null {
  const commonDir = readText(join(gitDir, "commondir"));
  const common = commonDir ? resolve(gitDir, commonDir) : gitDir;
  const loose = readText(join(common, ref));
  if (loose !== null) return COMMIT_ID.test(loose) ? loose : null;
  for (const line of (readText(join(common, "packed-refs")) ?? "").split("\n")) {
    const [id, name] = line.split(" ");
    if (name === ref && id !== undefined && COMMIT_ID.test(id)) return id;
  }
  return null;
}

/*
 * The commit of the code at `root`: the `REVISION` file an image build writes beside the code (an image holds no git history), else the HEAD
 * of the checkout the process runs from. Null when neither says, never a guess. The working tree's uncommitted edits are not part of it.
 */
export function revisionOf(root: string = APP_ROOT): string | null {
  const baked = readText(join(root, "REVISION"));
  if (baked !== null) return COMMIT_ID.test(baked) ? baked : null;
  const gitDir = gitDirOf(root);
  const head = gitDir ? readText(join(gitDir, "HEAD")) : null;
  if (head === null) return null;
  if (COMMIT_ID.test(head)) return head;
  const ref = head.match(/^ref:\s*(.+)$/)?.[1];
  return ref && gitDir ? commitOfRef(gitDir, ref) : null;
}

/* The version of the engine a run ran under: the package version and the first 12 characters of the commit of the code, or `unknown` when no commit is known. The package version alone does not move between commits, so it never stands for a version on its own. */
export function engineVersionOf(packageVersion: string, revision: string | null): string {
  return `${packageVersion}+${revision ? revision.slice(0, 12) : "unknown"}`;
}

export const ENGINE_VERSION = engineVersionOf(SERVER_VERSION, revisionOf());

export function handshake(clientVersion?: string, githubClientId?: string): VersionInfo {
  const compatible = clientVersion ? versionGte(clientVersion, MIN_CLIENT_VERSION) : true;
  return {
    serverVersion: SERVER_VERSION,
    apiVersion: WIRE_API_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    compatible,
    capabilities: [...CAPABILITIES],
    ...(githubClientId ? { githubClientId } : {}),
    ...(compatible ? {} : { message: `Update qayaba: this server requires client >= ${MIN_CLIENT_VERSION} (you have ${clientVersion}).` }),
  };
}

export function versionGte(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

function parseVersion(v: string): number[] {
  const core = v.replace(/^v/, "").split("-")[0] ?? "";
  return core.split(".").map((n) => Number.parseInt(n, 10) || 0);
}
