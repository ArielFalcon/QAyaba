/* Removes a tree the agent wrote, with bounds. `rmSync(recursive)` does not follow links, but it has no limit on how deep or how large the tree is or how long the removal takes, and the tree is the agent's to make (a probe directory it left behind): a path of ten thousand nested folders or millions of empty files would hold the orchestrator's one thread. This walks with an explicit entry, depth and time budget, looks at each entry without following it (a link is unlinked, whatever it points at), never opens a named pipe, and says so when a bound is passed, which the caller must treat as a failure to clean up. */

import { lstatSync, opendirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface TreeRemovalLimits {
  maxEntries: number;
  maxDepth: number;
  budgetMs: number;
}

export const DEFAULT_TREE_REMOVAL_LIMITS: TreeRemovalLimits = { maxEntries: 100_000, maxDepth: 64, budgetMs: 5_000 };

export class TreeRemovalLimitError extends Error {
  constructor(why: string) {
    super(`the tree could not be removed within its bounds (${why})`);
    this.name = "TreeRemovalLimitError";
  }
}

export interface TreeRemovalClock {
  now(): number;
}

const BATCH = 256;

/* Removes `path` and everything below it. A path that is not there is nothing to do. Throws TreeRemovalLimitError when a bound is passed or a pass removes nothing, and the failure itself for anything else. */
export function removeTreeBounded(path: string, limits: TreeRemovalLimits = DEFAULT_TREE_REMOVAL_LIMITS, clock: TreeRemovalClock = { now: () => performance.now() }): void {
  const started = clock.now();
  let entries = 0;
  const check = (): void => {
    if (clock.now() - started > limits.budgetMs) throw new TreeRemovalLimitError(`more than ${limits.budgetMs} ms`);
    if (entries > limits.maxEntries) throw new TreeRemovalLimitError(`more than ${limits.maxEntries} entries`);
  };

  const removeDirectory = (dir: string, depth: number): void => {
    if (depth > limits.maxDepth) throw new TreeRemovalLimitError(`deeper than ${limits.maxDepth} levels`);
    for (;;) {
      const names: string[] = [];
      const handle = opendirSync(dir);
      try {
        for (let entry = handle.readSync(); entry !== null && names.length < BATCH; entry = handle.readSync()) names.push(entry.name);
      } finally {
        handle.closeSync();
      }
      if (names.length === 0) break;
      for (const name of names) {
        entries += 1;
        check();
        const child = join(dir, name);
        const stats = lstatSync(child, { throwIfNoEntry: false });
        if (stats === undefined) continue;
        if (stats.isDirectory()) removeDirectory(child, depth + 1);
        else unlinkSync(child);
      }
    }
    rmdirSync(dir);
  };

  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return;
  if (!stats.isDirectory()) {
    unlinkSync(path);
    return;
  }
  removeDirectory(path, 0);
}
