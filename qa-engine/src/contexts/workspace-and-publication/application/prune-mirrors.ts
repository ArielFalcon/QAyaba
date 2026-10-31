/*
 * Mirror-cache pruning. The mirrors volume holds exactly ONE working copy per
 * repo (named by its slug), each with a full node_modules, so an offboarded app
 * leaves an orphaned mirror behind forever, and a long-idle mirror pins disk for
 * nothing. A pass deletes:
 * (a) mirrors whose repo is no longer referenced by any configured app
 * (neither as the primary `repo` nor in `services[].repo`), and
 * (b) configured mirrors not modified for more than PRUNE_MAX_AGE_MS
 * (the next run simply re-clones, an accepted cost).
 * It NEVER deletes a mirror belonging to the currently-running job, nor a directory
 * the composition names as reserved: the mirrors root also holds directories that
 * are not a repo's mirror. All side effects are injected (MirrorPruneDeps).
 */

import type { MirrorEntry, MirrorStorePort } from "./ports/mirror-store.port.ts";

export const PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;  /* 7 days */

export interface MirrorPruneDeps extends MirrorStorePort {
  mirrorRoot: string;
  /** Names under the mirrors root that are not a repo's mirror and are never pruned, however old. */
  reservedDirNames: readonly string[];
  /** Slugs of every repo referenced by a configured app (`repo` + `services[].repo`). */
  configuredRepoSlugs(): Set<string>;
  /** Slugs of the repos the currently-running job is using, never deleted. */
  activeRepoSlugs(): Set<string>;
  now(): number;
  log(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void;
}

export interface MirrorPruneResult {
  deleted: string[];  /* mirror names removed */
  freedBytes: number;
}

export function pruneMirrors(deps: MirrorPruneDeps): MirrorPruneResult {
  let entries: MirrorEntry[];
  try {
    entries = deps.listMirrorDirs(deps.mirrorRoot);
  } catch {
    deps.log("warn", "pruneMirrors: could not read mirror directory", { mirrorRoot: deps.mirrorRoot });
    return { deleted: [], freedBytes: 0 };
  }

  const reserved = new Set(deps.reservedDirNames);
  const configured = deps.configuredRepoSlugs();
  const active = deps.activeRepoSlugs();
  const now = deps.now();

  const deleted: string[] = [];
  let freedBytes = 0;
  for (const entry of entries) {
    if (reserved.has(entry.name)) continue;
    if (active.has(entry.name)) continue;  /* never touch the running job's mirrors */
    const isOrphan = !configured.has(entry.name);
    const isStale = now - entry.mtimeMs > PRUNE_MAX_AGE_MS;
    if (!isOrphan && !isStale) continue;
    try {
      const size = deps.directorySize(entry.path);
      deps.remove(entry.path);
      deleted.push(entry.name);
      freedBytes += size;
    } catch (err) {
      deps.log("warn", "pruneMirrors: failed to delete mirror", {
        path: entry.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (deleted.length > 0) {
    deps.log("info", "pruned old mirrors", {
      deletedCount: deleted.length,
      deleted,
      freedBytes,
      freedMB: Math.round(freedBytes / 1024 / 1024),
    });
  }
  return { deleted, freedBytes };
}
