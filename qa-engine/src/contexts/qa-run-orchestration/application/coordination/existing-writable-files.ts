// Filter sidekick-claimed files to those that actually exist under the mirror cwd.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isPathWithinWritableRoots } from "./path-scope.ts";

export function existingWritableFiles(
  cwd: string,
  files: readonly { path: string }[],
  writableRoots: readonly string[],
): { path: string }[] {
  const out: { path: string }[] = [];
  for (const f of files) {
    const p = f.path.replace(/\\/g, "/");
    if (!isPathWithinWritableRoots(p, writableRoots)) continue;
    if (!existsSync(join(cwd, p))) continue;
    out.push({ path: p });
  }
  return out;
}
