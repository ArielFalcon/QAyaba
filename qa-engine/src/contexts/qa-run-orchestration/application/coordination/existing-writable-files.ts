/*
 * Filter sidekick-claimed files to those that are regular files inside the mirror cwd. A claim is the
 * sidekick's word and a path it chose, so it counts only when the confined probe finds a regular file
 * whose real path lies inside the mirror: a symlink it planted that leads out of the mirror is not on
 * disk. The probe is injected (ExistingWritableFilesDeps) rather than hard-bound to the filesystem, so
 * this application-layer authority check can be exercised without touching a real filesystem — the fs
 * boundary is "behind a port" even though the function stays alongside path-scope.ts/pushback.ts, the
 * other authority checks it composes with.
 */
import { resolveConfinedSpecFile } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import { isPathWithinWritableRoots } from "./path-scope.ts";

export interface ExistingWritableFilesDeps {
  /* Whether `rel`, relative to the mirror `cwd`, names a regular file that lies inside it. */
  readonly isConfinedFile: (cwd: string, rel: string) => boolean;
}

export const defaultExistingWritableFilesDeps: ExistingWritableFilesDeps = {
  isConfinedFile: (cwd, rel) => resolveConfinedSpecFile({ mirrorDir: cwd, specDir: cwd }, rel) !== undefined,
};

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
    if (!deps.isConfinedFile(cwd, p)) continue;
    out.push({ path: p });
  }
  return out;
}
