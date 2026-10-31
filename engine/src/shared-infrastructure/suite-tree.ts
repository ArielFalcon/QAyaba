/*
 * What of a watched app's suite directory (`e2e/`) may leave it, and how it is walked. Shared by the suite store (the durable copy of
 * an accepted suite) and the experiment harness (warm-start snapshots): both copy a tree the agent writes into, so both walk it
 * without following a link, leave out what holds a credential or a login session, and read each file through the confined reader.
 *
 * Synchronous, and in shared-infrastructure because several contexts and the harness need it.
 */
import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { AUTH_MATERIAL_FILES } from "./process-sandbox/auth-session-env.ts";
import { readOwnedSpecFile, type SpecRoot } from "./spec-path-confinement.ts";

/** The largest file a copy of a suite takes; a bigger one stops the copy rather than being left out of the equality it promises. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** The most directory entries one walk looks at; a suite is some hundreds of files. */
export const MAX_TREE_ENTRIES = 100_000;
const MAX_SESSION_SNIFF_BYTES = 2 * 1024 * 1024;
export const NODE_MODULES = "node_modules";

/* ── what a copy of a suite leaves out ─────────────────────────────────────────────── */

/* Installed packages and what a run of the tests, the agent's tools or git leave behind. */
const OUTPUT_DIRS: ReadonlySet<string> = new Set([NODE_MODULES, "test-results", "playwright-report", "blob-report", ".serena", ".git"]);
/* The login session of a standalone Playwright run. */
const SESSION_DIRS: ReadonlySet<string> = new Set([".auth"]);
/* System-owned state the engine regenerates every run (the suite's .gitignore lists the same). */
const RUN_STATE_PATHS = [".qa/coverage", ".qa/fault-injection", ".qa/measured.json"] as const;
const LOGIN_MATERIAL_NAMES: ReadonlySet<string> = new Set(Object.values(AUTH_MATERIAL_FILES));
const ENV_FILE = /^\.env(\.|$)/;
const KEY_MATERIAL = /\.(p12|pfx|pem|key|jks|keystore)$/i;
const RECORDED_SESSION = /\.har$/i;
const LOG_FILE = /\.log$/i;

/**
 * Why a path (relative to the suite directory, "/"-separated) stays out of a copy, or undefined when it goes in. Decided
 * by the path alone; a `.json` file is also judged by its content (see `looksLikeSessionState`).
 */
export function exclusionReason(rel: string, isDirectory: boolean): string | undefined {
  const segments = rel.split("/");
  for (const segment of segments) {
    if (SESSION_DIRS.has(segment)) return "login session";
    if (OUTPUT_DIRS.has(segment)) return "install or run output";
  }
  if (RUN_STATE_PATHS.some((path) => rel === path || rel.startsWith(`${path}/`))) return "run state the engine regenerates";
  if (isDirectory) return undefined;
  const name = segments[segments.length - 1]!;
  if (ENV_FILE.test(name)) return "environment file (credentials)";
  if (KEY_MATERIAL.test(name) || LOGIN_MATERIAL_NAMES.has(name)) return "key or login material (credentials)";
  if (RECORDED_SESSION.test(name)) return "recorded browser session (cookies)";
  if (LOG_FILE.test(name)) return "log";
  return undefined;
}

/** Whether a `.json` file is a Playwright storage state (cookies and per-origin storage), whatever it is called. */
export function looksLikeSessionState(rel: string, bytes: Uint8Array): boolean {
  if (!rel.toLowerCase().endsWith(".json") || bytes.length > MAX_SESSION_SNIFF_BYTES) return false;
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as { cookies?: unknown; origins?: unknown } | null;
    return parsed !== null && typeof parsed === "object" && Array.isArray(parsed.cookies) && Array.isArray(parsed.origins);
  } catch {
    return false;
  }
}

/* ── walking a directory the agent writes into ─────────────────────────────────────── */

export type EntryKind = "file" | "dir" | "link" | "other";

export interface TreeEntry {
  rel: string;
  kind: EntryKind;
}

/** Throws unless `dir` is an ordinary directory: a link is never followed, and nothing else is a suite. */
export function assertRealDirectory(dir: string, what: string): void {
  let stats;
  try {
    stats = lstatSync(dir);
  } catch {
    throw new Error(`${what} ${dir} does not exist`);
  }
  if (stats.isSymbolicLink()) throw new Error(`${what} ${dir} is a symbolic link: it is never followed`);
  if (!stats.isDirectory()) throw new Error(`${what} ${dir} is not a directory`);
}

/**
 * Every entry below `root`, parents before children, each told apart by what it is itself (a link is never followed). A
 * directory is entered only when `enter` says so. More than `MAX_TREE_ENTRIES` entries, or a directory that cannot be
 * listed, stops the walk with an error: half a listing would make a copy or a restore wrong without saying so.
 */
export function walkTree(root: string, enter: (entry: TreeEntry) => boolean): TreeEntry[] {
  const out: TreeEntry[] = [];
  let left = MAX_TREE_ENTRIES;
  const visit = (dir: string, rel: string): void => {
    const handle = opendirSync(dir);
    const names: Array<{ name: string; kind: EntryKind }> = [];
    try {
      for (let e = handle.readSync(); e !== null; e = handle.readSync()) {
        if (left === 0) throw new Error(`${root} holds more than ${MAX_TREE_ENTRIES} entries: it is not a suite`);
        left -= 1;
        names.push({ name: e.name, kind: e.isDirectory() ? "dir" : e.isFile() ? "file" : e.isSymbolicLink() ? "link" : "other" });
      }
    } finally {
      handle.closeSync();
    }
    for (const { name, kind } of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const entry: TreeEntry = { rel: rel === "" ? name : `${rel}/${name}`, kind };
      out.push(entry);
      if (kind === "dir" && enter(entry)) visit(join(dir, name), entry.rel);
    }
  };
  visit(root, "");
  return out;
}

/** A recorded path is a plain relative path: no empty or `..` segment, no backslash, not absolute. */
export function assertSafeRelative(path: string): void {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`a manifest names an unsafe path: ${JSON.stringify(path)}`);
  }
}

/** The bytes of a file below the suite directory through the confined reader; anything it refuses, and a file that is not there, throws. */
export function readStrict(root: SpecRoot, rel: string, maxBytes: number): Buffer {
  const read = readOwnedSpecFile(root, rel, maxBytes);
  if ("bytes" in read) return read.bytes;
  if ("absent" in read) throw new Error(`${rel}: the file is not there`);
  throw new Error(`${rel}: ${read.reason}`);
}
