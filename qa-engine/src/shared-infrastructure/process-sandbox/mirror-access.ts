/* The mirrors volume holds every watched repo's working copy, and the agents container writes into it as root. The sandbox uid must read the one mirror a run executes in and no other: the mirror root is traversable but not listable (0711), every mirror is closed to everyone but root (0750 root:root), and the mirror a run executes in gets the sandbox's group for the length of the run (root:<sandbox gid>, 0750), then goes back. Files in a mirror stay root-owned and world-readable, so the sandbox can read specs and the installed packages and cannot change them: the only writable place is its work dir (the dump folders of a suite run lead there too, and only what passes the check is carried back: run-dump-bridge.ts).
   A mirror the sandbox already owns (the code target hands its repo to the sandbox for a build to write in) is left as it is. The file operations are injected so the rules are testable without being root. */

import { chmodSync, chownSync, lstatSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import type { Sandbox } from "./sandbox.ts";

export interface MirrorFsOps {
  lstat(path: string): { isDirectory(): boolean; uid: number };
  readdir(path: string): string[];
  chown(path: string, uid: number, gid: number): void;
  chmod(path: string, mode: number): void;
}

export const nodeMirrorFsOps: MirrorFsOps = {
  lstat: (path) => lstatSync(path),
  readdir: (path) => readdirSync(path),
  chown: chownSync,
  chmod: chmodSync,
};

/* The first path segment below the mirror root that `cwd` is in, or undefined when `cwd` is not in a mirror. */
export function mirrorTopDir(mirrorRoot: string, cwd: string): string | undefined {
  const root = mirrorRoot.endsWith(sep) ? mirrorRoot : mirrorRoot + sep;
  if (!cwd.startsWith(root)) return undefined;
  const first = cwd.slice(root.length).split(sep)[0];
  return first ? join(mirrorRoot, first) : undefined;
}

/* Boot: the mirror root traversable but not listable, every mirror closed to all but root. A link is never followed. */
export function sealMirrors(mirrorRoot: string, ops: MirrorFsOps = nodeMirrorFsOps): void {
  ops.chmod(mirrorRoot, 0o711);
  for (const name of ops.readdir(mirrorRoot)) {
    const path = join(mirrorRoot, name);
    const stat = ops.lstat(path);
    if (!stat.isDirectory()) continue;
    ops.chown(path, 0, 0);
    ops.chmod(path, 0o750);
  }
}

/* Gives the sandbox's group traversal of the mirror. Returns whether it changed anything, so that only a change is undone. */
export function openMirrorForSandbox(mirrorDir: string, sandbox: Sandbox | null, ops: MirrorFsOps = nodeMirrorFsOps): boolean {
  if (!sandbox) return false;
  const stat = ops.lstat(mirrorDir);
  if (!stat.isDirectory() || stat.uid !== 0) return false;
  ops.chown(mirrorDir, 0, sandbox.gid);
  ops.chmod(mirrorDir, 0o750);
  return true;
}

export function closeMirror(mirrorDir: string, ops: MirrorFsOps = nodeMirrorFsOps): void {
  const stat = ops.lstat(mirrorDir);
  if (!stat.isDirectory()) return;
  ops.chown(mirrorDir, 0, 0);
  ops.chmod(mirrorDir, 0o750);
}
