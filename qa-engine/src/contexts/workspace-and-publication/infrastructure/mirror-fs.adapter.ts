import { join } from "node:path";
import { readdirSync, rmSync, statSync } from "node:fs";
import type { MirrorEntry, MirrorStorePort } from "../application/ports/mirror-store.port.ts";

/* The mirrors root on the real file system. A mirror is removed as a whole tree, and a link in the root is removed itself, never followed by the removal. */

/* Bytes of the regular files below `dir`; an unreadable file or directory counts for nothing. */
export function getDirectorySize(dir: string): number {
  let size = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        size += getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        try {
          size += statSync(fullPath).size;
        } catch {
          /* ignore unreadable files */
        }
      }
    }
  } catch {
    /* ignore unreadable directories */
  }
  return size;
}

export const fsMirrorStore: MirrorStorePort = {
  listMirrorDirs: (root) => {
    const out: MirrorEntry[] = [];
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      try {
        const s = statSync(path);
        if (s.isDirectory()) out.push({ name, path, mtimeMs: s.mtimeMs });
      } catch {
        /* entry vanished mid-scan — skip */
      }
    }
    return out;
  },
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  directorySize: getDirectorySize,
};
