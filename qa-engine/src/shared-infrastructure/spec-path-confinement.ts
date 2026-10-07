/* The one reader of a path an agent reported. The agent writes the suite's spec files and names them in its verdict, so a reported name is untrusted input: it can be absolute, climb out with `..`, or be a symlink or a named pipe the agent planted. Every orchestrator read or probe of such a name goes through here, anchored on the real location of the mirror, and none of them follows a link out of the spec directory or opens anything that is not a regular file. Synchronous, and it lives in shared-infrastructure because the kernel holds no fs code and several contexts need it. */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

/* A spec is source a person would read; one larger than this is not read. */
export const MAX_SPEC_SOURCE_BYTES = 256 * 1024;

/* Where the specs of a run live and the checkout that holds them. For a code run the two are the same directory. */
export interface SpecRoot {
  mirrorDir: string;
  specDir: string;
}

/* A reported path that the confinement refused. `path` is the path exactly as it was reported. */
export class ConfinedPathError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`);
    this.name = new.target.name;
  }
}

type Confined = { file: string } | { reason: string };

/* `child` is `parent` or lies below it. Both are real paths, so no `..` or symlink is left to read around the prefix, and the separator keeps `/a/mirror-evil` out of `/a/mirror`. */
function inside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

/* The real spec directory, once it is known to be an ordinary directory of the mirror. A symlinked spec directory is refused even when it points inside the mirror, and its trailing separator is dropped first: a path ending in one makes lstat follow the link and report its target. */
function confineSpecDir(root: SpecRoot): { dir: string } | { reason: string } {
  const specDir = resolve(root.specDir);
  try {
    if (lstatSync(specDir).isSymbolicLink()) return { reason: "the spec directory is a symbolic link" };
    const dir = realpathSync(specDir);
    return inside(realpathSync(root.mirrorDir), dir) ? { dir } : { reason: "the spec directory is outside the mirror" };
  } catch {
    return { reason: "the spec directory or the mirror cannot be resolved" };
  }
}

/* The real path of the regular file `reported` names inside the spec directory, or why it is refused. Nothing is opened: a named pipe or a device is judged by lstat alone. */
function confine(root: SpecRoot, reported: string): Confined {
  const normalized = reported.replaceAll("\\", "/");
  if (normalized === "") return { reason: "the path is empty" };
  if (isAbsolute(normalized)) return { reason: "the path is absolute" };
  if (normalized.split("/").includes("..")) return { reason: "the path has a parent-directory segment" };

  const spec = confineSpecDir(root);
  if ("reason" in spec) return spec;
  try {
    const file = realpathSync(join(spec.dir, normalized));
    if (!inside(spec.dir, file)) return { reason: "the path leaves the spec directory" };
    return lstatSync(file).isFile() ? { file } : { reason: "the path is not a regular file" };
  } catch {
    return { reason: "the path cannot be resolved" };
  }
}

/* The real path of the regular file an agent reported, or undefined when there is none inside the spec directory (deleted, renamed away, a link out, not a file). Never opens it. */
export function resolveConfinedSpecFile(root: SpecRoot, reported: string): string | undefined {
  const confined = confine(root, reported);
  return "file" in confined ? confined.file : undefined;
}

/* The bytes of the file an agent reported, read through a descriptor that does not follow a symlink and never beyond `maxBytes`. Throws ConfinedPathError when the path is refused or the file is larger than the cap; any other failure (an unreadable file) is thrown as it is. */
export function readConfinedSpecBytes(root: SpecRoot, reported: string, maxBytes: number = MAX_SPEC_SOURCE_BYTES): Buffer {
  const confined = confine(root, reported);
  if ("reason" in confined) throw new ConfinedPathError(reported, confined.reason);
  /* The real path has no symlink left in it; the flag refuses one swapped in between the check and the open. */
  const fd = openSync(confined.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = fstatSync(fd);
    if (size > maxBytes) throw new ConfinedPathError(reported, `the file is larger than ${maxBytes} bytes`);
    const bytes = Buffer.alloc(size);
    return bytes.subarray(0, readSync(fd, bytes, 0, size, 0));
  } finally {
    closeSync(fd);
  }
}

/* readConfinedSpecBytes, decoded as UTF-8. */
export function readConfinedSpecFile(root: SpecRoot, reported: string, maxBytes?: number): string {
  return readConfinedSpecBytes(root, reported, maxBytes).toString("utf8");
}
