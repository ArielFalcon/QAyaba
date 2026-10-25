/*
 * The persistent store cache, one per (app, repo), so a run syncs the last store instead of indexing the repo from nothing.
 * It lives under the orchestrator's data directory, which the sandbox uid can neither list nor write (proven at boot by the
 * file-boundary check): a run's spec cannot poison the next run's index. A run copies the store in, syncs it in its own
 * workspace, and publishes it back here before any agent-influenced code runs, under a lock so parallel lanes cannot race.
 * A store that did not build, or did not validate, never reaches the cache: the publish is a copy to a temporary name and a
 * rename, and the metadata (engine, engine version and the commit the store was built at) is renamed in after it. The
 * metadata is the index cursor: a store of another engine or version is never reused, and a missing or wiped store is never
 * mistaken for an indexed one.
 */

import { randomBytes } from "node:crypto";
import { chownSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readOwnedSpecFile } from "../spec-path-confinement.ts";
import type { Sandbox } from "../process-sandbox/sandbox.ts";
import { STORE_DIR } from "./codegraph-workspace.ts";

export interface StoreMeta {
  engine: string;
  engineVersion: string;
  /* The commit the store was built at: the run's SHA when it was published. */
  sha: string;
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  builtAt: string;
}

const STORE_FILE = "codegraph.db";
const META_FILE = "meta.json";
const LOCK_FILE = "lock";
/* A store larger than this is not published: the engine wrote something no repo of the declared scope produces. */
export const MAX_STORE_BYTES = 1024 * 1024 * 1024;
/* A lock older than this was left by a process that died holding it. */
const STALE_LOCK_MS = 15 * 60_000;

export interface StoreLock {
  release(): void;
}

/* The cache key of a repo: its mirror's name, reduced to a file name. */
export function repoKeyOf(name: string): string {
  const key = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return key === "" ? "_" : key.slice(0, 200);
}

export class CodegraphStoreCache {
  constructor(
    /* `<data dir>/code-graph/<app>`. */
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  private dirOf(repoKey: string): string {
    return join(this.root, repoKeyOf(repoKey));
  }

  private ensureDir(repoKey: string): string {
    const dir = this.dirOf(repoKey);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /* Takes the repo's lock, breaking one older than STALE_LOCK_MS; undefined when another run holds it. */
  lock(repoKey: string): StoreLock | undefined {
    const path = join(this.ensureDir(repoKey), LOCK_FILE);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        writeFileSync(fd, `${process.pid} ${this.now()}\n`);
        closeSync(fd);
        return { release: () => rmSync(path, { force: true }) };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const age = this.now() - statSync(path).mtimeMs;
        if (age < STALE_LOCK_MS) return undefined;
        rmSync(path, { force: true });
      }
    }
    return undefined;
  }

  meta(repoKey: string): StoreMeta | undefined {
    const path = join(this.dirOf(repoKey), META_FILE);
    if (!existsSync(join(this.dirOf(repoKey), STORE_FILE)) || !existsSync(path)) return undefined;
    try {
      const m = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreMeta>;
      if (typeof m.engine !== "string" || typeof m.engineVersion !== "string" || typeof m.sha !== "string") return undefined;
      return m as StoreMeta;
    } catch {
      return undefined;
    }
  }

  /* Copies the cached store into the workspace's store directory, owned by the sandbox so the engine can sync it. False when there is none. */
  copyIn(repoKey: string, workspace: string, sandbox: Sandbox | null): boolean {
    const source = join(this.dirOf(repoKey), STORE_FILE);
    if (!existsSync(source)) return false;
    const target = join(workspace, STORE_DIR, STORE_FILE);
    copyFileSync(source, target);
    if (sandbox) chownSync(target, sandbox.uid, sandbox.gid);
    return true;
  }

  /*
   * Publishes the workspace's store. The store was written by the sandbox uid, so it is read like any file the sandbox can
   * plant: no link, no pipe, a regular file of bounded size (the confined reader). A store whose write-ahead log is still
   * beside it is not complete on its own and is refused.
   */
  publish(repoKey: string, workspace: string, meta: StoreMeta): { published: true } | { published: false; reason: string } {
    const root = { mirrorDir: workspace, specDir: join(workspace, STORE_DIR) };
    if (existsSync(join(workspace, STORE_DIR, `${STORE_FILE}-wal`))) return { published: false, reason: "the store still has a write-ahead log" };
    const read = readOwnedSpecFile(root, STORE_FILE, MAX_STORE_BYTES);
    if (!("bytes" in read)) return { published: false, reason: "absent" in read ? "the workspace has no store" : read.reason };
    const dir = this.ensureDir(repoKey);
    const tag = randomBytes(6).toString("hex");
    const storeTmp = join(dir, `${STORE_FILE}.${tag}.tmp`);
    const metaTmp = join(dir, `${META_FILE}.${tag}.tmp`);
    try {
      writeFileSync(storeTmp, read.bytes, { mode: 0o600 });
      writeFileSync(metaTmp, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
      renameSync(storeTmp, join(dir, STORE_FILE));
      renameSync(metaTmp, join(dir, META_FILE));
      return { published: true };
    } catch (e) {
      rmSync(storeTmp, { force: true });
      rmSync(metaTmp, { force: true });
      return { published: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }
}
