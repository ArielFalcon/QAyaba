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
import { chownSync, closeSync, constants, copyFileSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { probeOwnedSpecFile } from "../spec-path-confinement.ts";
import type { Sandbox } from "../process-sandbox/sandbox.ts";
import { STORE_DIR } from "./codegraph-workspace.ts";

export interface StoreMeta {
  engine: string;
  engineVersion: string;
  /* A digest of the workspace scope (extensions, manifests, exclusions) the store was built from. */
  scope: string;
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

/* A store is copied in pieces of this size, so publishing never holds the store in memory. */
const COPY_CHUNK_BYTES = 4 * 1024 * 1024;

export interface StoreLock {
  release(): void;
}

/* The calls and bounds a test replaces: the rename between which a crash can land, the copy's piece size, the size cap, and the instant between a lock being judged stale and being taken over. */
export interface StoreCacheTuning {
  rename?: (from: string, to: string) => void;
  chunkBytes?: number;
  maxStoreBytes?: number;
  beforeTakeover?: () => void;
  beforeRemoveStale?: () => void;
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
    private readonly tuning: StoreCacheTuning = {},
  ) {}

  private dirOf(repoKey: string): string {
    return join(this.root, repoKeyOf(repoKey));
  }

  private ensureDir(repoKey: string): string {
    const dir = this.dirOf(repoKey);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /*
   * Takes the repo's lock; undefined when another run holds it. A lock older than STALE_LOCK_MS was left by a process that
   * died holding it, and exactly one taker breaks it: the break happens under an exclusive claim file, and the lock that
   * is removed must still be the one judged stale (same holder token and modification time), so a lock another taker has just
   * made is never removed. A lock is released only by its own holder, so a holder that outlived its lock never removes the
   * lock of whoever took over.
   */
  lock(repoKey: string): StoreLock | undefined {
    const path = join(this.ensureDir(repoKey), LOCK_FILE);
    const create = (): StoreLock | undefined => {
      const token = `${process.pid} ${randomBytes(6).toString("hex")}`;
      try {
        const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        try {
          writeFileSync(fd, `${token}\n`);
        } finally {
          closeSync(fd);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return undefined;
        throw e;
      }
      return {
        release: () => {
          try {
            if (readFileSync(path, "utf8").trim() === token) rmSync(path, { force: true });
          } catch {
            /* already gone */
          }
        },
      };
    };
    const held = create();
    if (held) return held;
    const seen = this.statOrUndefined(path);
    if (seen === undefined) return create();
    if (this.now() - seen.mtimeMs < STALE_LOCK_MS) return undefined;
    this.tuning.beforeTakeover?.();
    const claim = `${path}.takeover`;
    try {
      closeSync(openSync(claim, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      /* Another taker is at it; a claim left by one that died is cleared so that a later run can take over. */
      const claimed = this.statOrUndefined(claim);
      if (claimed !== undefined && this.now() - claimed.mtimeMs >= STALE_LOCK_MS) rmSync(claim, { force: true });
      return undefined;
    }
    try {
      const again = this.statOrUndefined(path);
      if (again !== undefined) {
        if (again.holder !== seen.holder || again.mtimeMs !== seen.mtimeMs) return undefined;
        this.tuning.beforeRemoveStale?.();
        /* The lock is moved aside, an atomic step that captures exactly the file there now, and removed only when it is still the
           stale one: a lock created after the re-check (its holder released and another run took it) is put back. */
        const aside = `${path}.${randomBytes(6).toString("hex")}.stale`;
        try {
          renameSync(path, aside);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        const moved = this.statOrUndefined(aside);
        if (moved !== undefined && moved.holder !== seen.holder) {
          try {
            linkSync(aside, path);
          } catch {
            /* the lock was taken again meanwhile; its holder keeps it */
          }
          rmSync(aside, { force: true });
          return undefined;
        }
        rmSync(aside, { force: true });
      }
      return create();
    } finally {
      rmSync(claim, { force: true });
    }
  }

  /* Whether a write-ahead log beside the store may hold frames the store lacks: anything there but an empty regular file. */
  private pendingLog(path: string): boolean {
    try {
      const st = lstatSync(path);
      return !st.isFile() || st.size > 0;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }

  /* The age and the holder's token of a lock or claim file, or undefined when it is not there. */
  private statOrUndefined(path: string): { holder: string; mtimeMs: number } | undefined {
    try {
      const st = statSync(path);
      return { holder: readFileSync(path, "utf8"), mtimeMs: st.mtimeMs };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  /* Forgets the repo's cached store, so the next run builds it from nothing. For a store the incremental path cannot bring up to date. */
  discard(repoKey: string): void {
    const dir = this.dirOf(repoKey);
    rmSync(join(dir, META_FILE), { force: true });
    rmSync(join(dir, STORE_FILE), { force: true });
  }

  meta(repoKey: string): StoreMeta | undefined {
    const path = join(this.dirOf(repoKey), META_FILE);
    if (!existsSync(join(this.dirOf(repoKey), STORE_FILE)) || !existsSync(path)) return undefined;
    try {
      const m = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreMeta>;
      if (typeof m.engine !== "string" || typeof m.engineVersion !== "string" || typeof m.scope !== "string" || typeof m.sha !== "string") return undefined;
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
   * plant: no link, no pipe, a regular file of bounded size (the confined reader). The workspace itself lies in a directory
   * the sandbox owns, so it must still be the directory the orchestrator built (`identity`, taken right after the export):
   * a link or a replacement in its place is refused. A store whose write-ahead log still holds frames is not complete on
   * its own and is refused; the empty log a read-only open of a WAL-mode store leaves behind holds none.
   */
  publish(repoKey: string, workspace: string, identity: { dev: number; ino: number }, meta: StoreMeta): { published: true } | { published: false; reason: string } {
    let now;
    try {
      now = lstatSync(workspace);
    } catch {
      return { published: false, reason: "the workspace is gone" };
    }
    if (!now.isDirectory() || now.dev !== identity.dev || now.ino !== identity.ino) return { published: false, reason: "the workspace was replaced" };
    const root = { mirrorDir: workspace, specDir: join(workspace, STORE_DIR) };
    if (this.pendingLog(join(workspace, STORE_DIR, `${STORE_FILE}-wal`))) return { published: false, reason: "the store still has a write-ahead log" };
    const probed = probeOwnedSpecFile(root, STORE_FILE);
    if (probed !== "file") return { published: false, reason: probed === "absent" ? "the workspace has no store" : probed.reason };
    const dir = this.ensureDir(repoKey);
    const tag = randomBytes(6).toString("hex");
    const storeTmp = join(dir, `${STORE_FILE}.${tag}.tmp`);
    const metaTmp = join(dir, `${META_FILE}.${tag}.tmp`);
    const rename = this.tuning.rename ?? renameSync;
    try {
      const copied = this.copyStrictly(join(workspace, STORE_DIR, STORE_FILE), storeTmp);
      if (copied !== undefined) {
        rmSync(storeTmp, { force: true });
        return { published: false, reason: copied };
      }
      writeFileSync(metaTmp, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
      /* The metadata is the cursor: it goes first, so a crash between the renames leaves a store without a cursor (rebuilt), never one store under another commit's cursor. */
      rmSync(join(dir, META_FILE), { force: true });
      rename(storeTmp, join(dir, STORE_FILE));
      rename(metaTmp, join(dir, META_FILE));
      return { published: true };
    } catch (e) {
      rmSync(storeTmp, { force: true });
      rmSync(metaTmp, { force: true });
      return { published: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /*
   * Copies a file the sandbox could write to `target` in pieces, without holding it in memory, and with the checks of the
   * confined reader: opened without following a link and without waiting on a pipe, a regular file whose size is within
   * the cap, and still the file the path names (device and inode) before and after the copy. Returns why it refused, or undefined.
   */
  private copyStrictly(source: string, target: string): string | undefined {
    const max = this.tuning.maxStoreBytes ?? MAX_STORE_BYTES;
    const chunk = Buffer.alloc(this.tuning.chunkBytes ?? COPY_CHUNK_BYTES);
    const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile()) return "the store is not a regular file";
      if (opened.size > BigInt(max)) return `the store is larger than ${max} bytes`;
      const named = lstatSync(source, { bigint: true });
      if (!named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) return "the store changed between check and open";
      const out = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        const size = Number(opened.size);
        let copied = 0;
        while (copied < size) {
          const read = readSync(fd, chunk, 0, Math.min(chunk.length, size - copied), copied);
          if (read === 0) return "the store ended before its size";
          let written = 0;
          while (written < read) written += writeSync(out, chunk, written, read - written);
          copied += read;
        }
      } finally {
        closeSync(out);
      }
      const after = lstatSync(source, { bigint: true });
      return after.isFile() && after.dev === opened.dev && after.ino === opened.ino ? undefined : "the store changed during the copy";
    } finally {
      closeSync(fd);
    }
  }
}
