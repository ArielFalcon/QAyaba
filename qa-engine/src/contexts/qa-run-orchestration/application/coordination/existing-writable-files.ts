/*
 * Filter sidekick-claimed files to those that actually exist under the mirror cwd. fs access is
 * injected (ExistingWritableFilesDeps) rather than hard-bound to node:fs's existsSync, so this
 * application-layer authority check can be exercised without touching a real filesystem — the fs
 * boundary is "behind a port" even though the function stays alongside path-scope.ts/pushback.ts,
 * the other authority checks it composes with.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isPathWithinWritableRoots } from "./path-scope.ts";

export interface ExistingWritableFilesDeps {
  readonly existsSync: (path: string) => boolean;
}

export const defaultExistingWritableFilesDeps: ExistingWritableFilesDeps = { existsSync };

export function existingWritableFiles(
  cwd: string,
  files: readonly { path: string }[],
  writableRoots: readonly string[],
  deps: ExistingWritableFilesDeps = defaultExistingWritableFilesDeps,
): { path: string }[] {
  const out: { path: string }[] = [];
  for (const f of files) {
    const p = f.path.replace(/\\/g, "/");
    if (!isPathWithinWritableRoots(p, writableRoots)) continue;
    if (!deps.existsSync(join(cwd, p))) continue;
    out.push({ path: p });
  }
  return out;
}
