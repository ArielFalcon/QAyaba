/* service-topology/infrastructure/repo-walk.ts Deterministic recursive directory walk shared by HTTP boundary resolvers. Vendor/build directories are skipped — they are never a genuine call-site. readdirSync order is filesystem-dependent, so entries are sorted before descent (project invariant #1). */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SKIP_VENDOR_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", ".next", ".cache",
]);

/** Recursively walk a directory, collecting files matching the predicate. */
export function walkRepoFiles(dir: string, predicate: (name: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir).sort(); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_VENDOR_DIRS.has(entry)) continue;
      walkRepoFiles(full, predicate, out);
    } else if (predicate(entry)) out.push(full);
  }
  return out;
}
