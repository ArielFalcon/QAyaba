/* The one reader of a path an agent reported. The agent writes the suite's spec files and names them in its verdict, so a reported name is untrusted input: it can be absolute, climb out with `..`, or be a symlink or a named pipe the agent planted. Every orchestrator read or probe of such a name goes through here, anchored on the real location of the mirror, and none of them follows a link out of the spec directory or reads anything but the regular file it validated. A file is judged by lstat before it is opened, so a named pipe or a device is not opened on purpose.
   The path can still be swapped between that check and the open by a process the agent left running, and O_NOFOLLOW covers only the last component, so the descriptor is judged as well. Where the platform can name the file a descriptor really is (Linux, through procfs), that kernel path must lie inside the spec directory: it does not depend on any path being walked again, and it closes the window for every file the agent cannot move into the spec directory, which is every file outside the volume it shares with the orchestrator. Where the platform cannot (macOS), the descriptor's device and inode must equal those of the file validated before the open and again after it: that narrows the window to a process flipping the path at exactly the right instants, and does not close it. Hard links stay out of scope. A file is read whole or not at all.
   Synchronous, and it lives in shared-infrastructure because the kernel holds no fs code and several contexts need it. */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

/* A spec is source a person would read; one larger than this is not read. */
export const MAX_SPEC_SOURCE_BYTES = 256 * 1024;

/* Where the specs of a run live and the checkout that holds them. For a code run the two are the same directory. */
export interface SpecRoot {
  mirrorDir: string;
  specDir: string;
}

/* What the read asks of an opened descriptor. The inode number is exact: a number would lose its low bits on a filesystem with 64-bit inode numbers, and two files could then look alike. */
export interface OpenedFileStats {
  dev: bigint;
  ino: bigint;
  size: bigint;
  isFile(): boolean;
}

/* The calls between which a validated path can be swapped, and the ones that say what a descriptor is. Real in production; a test makes the swap itself, at exactly that point, with the real calls around it. */
export interface SpecReadDeps {
  open(path: string, flags: number): number;
  fstat(fd: number): OpenedFileStats;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  /* The kernel's own path of an open descriptor, or undefined where the platform has none. */
  fdPath(fd: number): string | undefined;
}

/* The real calls for a platform. Linux names a descriptor through procfs; a failure to read that link is thrown, never answered with undefined, so the weaker check does not stand in for the stronger one where the stronger one exists. */
export function specReadDepsFor(platform: NodeJS.Platform, readlink: (path: string) => string = readlinkSync): SpecReadDeps {
  return {
    open: (path, flags) => openSync(path, flags),
    fstat: (fd) => fstatSync(fd, { bigint: true }),
    read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
    fdPath: platform === "linux" ? (fd) => readlink(`/proc/self/fd/${fd}`) : () => undefined,
  };
}

export const defaultSpecReadDeps: SpecReadDeps = specReadDepsFor(process.platform);

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

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

type Confined = ({ file: string; dir: string } & FileIdentity) | { reason: string };

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

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

/* The real path of the regular file `reported` names inside the spec directory, with its identity and the real spec directory it was found in, or why it is refused. Nothing is opened: a named pipe or a device is judged by lstat alone. */
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
    const stats = lstatSync(file, { bigint: true });
    return stats.isFile() ? { file, dir: spec.dir, dev: stats.dev, ino: stats.ino } : { reason: "the path is not a regular file" };
  } catch {
    return { reason: "the path cannot be resolved" };
  }
}

/* The real path of the regular file an agent reported, or undefined when there is none inside the spec directory (deleted, renamed away, a link out, not a file). Never opens it. */
export function resolveConfinedSpecFile(root: SpecRoot, reported: string): string | undefined {
  const confined = confine(root, reported);
  return "file" in confined ? confined.file : undefined;
}

/* The bytes of the file an agent reported, read through a descriptor that is the validated file, whole, and never beyond `maxBytes`. Throws ConfinedPathError when the path is refused, when the file opened is not the one that was validated, when it is larger than the cap, or when it ends before its size; any other failure (an unreadable file) is thrown as it is. */
export function readConfinedSpecBytes(root: SpecRoot, reported: string, maxBytes: number = MAX_SPEC_SOURCE_BYTES, deps: SpecReadDeps = defaultSpecReadDeps): Buffer {
  const checked = confine(root, reported);
  if ("reason" in checked) throw new ConfinedPathError(reported, checked.reason);
  /* Read-only, not following a link in the last component, and not waiting for a writer should a named pipe have been swapped in since the check: the descriptor is judged below, never trusted. */
  const fd = deps.open(checked.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = deps.fstat(fd);
    /* Inside the spec directory the check validated, which is inside the mirror: the check made it so. */
    const kernelPath = deps.fdPath(fd);
    if (kernelPath !== undefined && !inside(checked.dir, kernelPath)) {
      throw new ConfinedPathError(reported, "the file that was opened is outside the spec directory");
    }
    /* The descriptor must be a regular file, the one that was validated before the open and the one that validates again after it. The second look matters where there is no kernel path: a swap can land between the realpath and the lstat of the first one, and then the open and that lstat agree on the wrong file. */
    const rechecked = confine(root, reported);
    if (!opened.isFile() || !("file" in rechecked) || !sameFile(opened, checked) || !sameFile(opened, rechecked)) {
      throw new ConfinedPathError(reported, "changed between check and open");
    }
    const size = Number(opened.size);
    if (size > maxBytes) throw new ConfinedPathError(reported, `the file is larger than ${maxBytes} bytes`);
    const bytes = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
      const read = deps.read(fd, bytes, filled, size - filled, filled);
      if (read === 0) throw new ConfinedPathError(reported, "short read");
      filled += read;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/* readConfinedSpecBytes, decoded as UTF-8. */
export function readConfinedSpecFile(root: SpecRoot, reported: string, maxBytes?: number): string {
  return readConfinedSpecBytes(root, reported, maxBytes).toString("utf8");
}
