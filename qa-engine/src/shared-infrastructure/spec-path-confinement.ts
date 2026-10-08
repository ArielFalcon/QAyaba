/* The one reader of a path an agent reported. The agent writes the suite's spec files and names them in its verdict, so a reported name is untrusted input: it can be absolute, climb out with `..`, or be a symlink or a named pipe the agent planted. Every orchestrator read or probe of such a reported name goes through here (the generation port's spec sources and the specs it hands a regeneration, the reviewer's inlining, the review DOM grounding, the manifest's file hashes, the sidekick's claimed files and the pre-exec capture), anchored on the real location of the mirror, and none of them follows a link out of the spec directory or reads anything but the regular file it validated. A file is judged by lstat before it is opened, so a named pipe or a device is not opened on purpose.
   The path can still be swapped between that check and the open by a process the agent left running, and O_NOFOLLOW covers only the last component, so the descriptor is judged as well. Where the platform can name the file a descriptor really is (Linux, through procfs), that kernel path must lie inside the spec directory: it does not depend on any path being walked again, and it closes the window for every file the agent cannot move into the spec directory, which is every file outside the volume it shares with the orchestrator. Where the platform cannot (macOS), the descriptor's device and inode must equal those of the file validated before the open and again after it: that narrows the window to a process flipping the path at exactly the right instants, and does not close it. Hard links stay out of scope. A file is read whole or not at all.
   The orchestrator also reads, lists and keeps files in that directory that no verdict names, where the agent can plant a link at the file or at the directory above it, a named pipe, or a file or a directory of any size. Those are read, listed and written strictly, by `readOwnedSpecFile`, `listOwnedSpecDir` and `writeOwnedSpecFile`: no symlink anywhere below the spec directory, a regular file at the end of a path (an ordinary directory, listed entry by entry up to a cap, for a directory), a read under a cap, and a write that goes through an exclusively created temporary file renamed over the target, never through a link. A directory is judged by its path before it is opened and is not looked at again, since only its names are taken: a swap in that window can show the names of another directory, never what an entry holds, because every entry is then read through the strict read of its own.
   Exactly what goes through here. The reported names above. The manifest and the context map, in `.qa`. What setup reads and replaces in the project directory: the fixtures file, the ignore file, the login setup, the Playwright config, the lock file and the install marker (which `git clean -fd -e node_modules` leaves in place from one run to the next). The login's stock check of `auth.setup.ts`. What a run of the tests leaves for the orchestrator to read: the coverage dumps under `.qa/coverage`, the native coverage reports of a code run (lcov, Istanbul, JaCoCo) and the fault-injection counters under `.qa/fault-injection`. The specs that the read gate scans and the grounding lists, which are listed without following a link (`scanSpecTree`, `listSpecFiles`) and read like a reported name; what the walk could not walk (a link to a directory, a directory it could not list) is named, and the read gate refuses it. There is no analysis map to read: the agent writes `.qa/analysis.json` and no orchestrator code opens it. Not read through here: the fixtures file read for harness facts, which has an open of its own that neither follows a link nor waits on a pipe; the failure-capture dumps and the Playwright report that the e2e runner reads back from the temporary directories it makes for a run of the tests; and the files of other repositories' mirrors that the staging of a service's context and the topology resolvers read.
   Synchronous, and it lives in shared-infrastructure because the kernel holds no fs code and several contexts need it. */

import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, opendirSync, openSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, type Dirent } from "node:fs";
import { basename, isAbsolute, join, posix, resolve, sep } from "node:path";

/* A spec, a fixtures file, a login script or a config file is source a person would read; one larger than this is not read. */
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

/* The same for a write: the exclusive creation of the temporary file, the kernel's path of it, the close of its descriptor, the rename over the target, and the name. */
export interface SpecWriteDeps {
  open(path: string, flags: number, mode: number): number;
  fdPath(fd: number): string | undefined;
  close(fd: number): void;
  rename(from: string, to: string): void;
  randomSuffix(): string;
}

/* The kernel's own path of an open descriptor, where the platform offers one: Linux, through procfs. A failure to read that link is thrown, never answered with undefined, so the weaker check does not stand in for the stronger one where the stronger one exists. */
function fdPathFor(platform: NodeJS.Platform, readlink: (path: string) => string): (fd: number) => string | undefined {
  return platform === "linux" ? (fd) => readlink(`/proc/self/fd/${fd}`) : () => undefined;
}

/* The real calls for a platform. */
export function specReadDepsFor(platform: NodeJS.Platform, readlink: (path: string) => string = readlinkSync): SpecReadDeps {
  return {
    open: (path, flags) => openSync(path, flags),
    fstat: (fd) => fstatSync(fd, { bigint: true }),
    read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
    fdPath: fdPathFor(platform, readlink),
  };
}

export function specWriteDepsFor(platform: NodeJS.Platform, readlink: (path: string) => string = readlinkSync): SpecWriteDeps {
  return {
    open: (path, flags, mode) => openSync(path, flags, mode),
    fdPath: fdPathFor(platform, readlink),
    close: (fd) => closeSync(fd),
    rename: (from, to) => renameSync(from, to),
    randomSuffix: () => randomBytes(8).toString("hex"),
  };
}

export const defaultSpecReadDeps: SpecReadDeps = specReadDepsFor(process.platform);
export const defaultSpecWriteDeps: SpecWriteDeps = specWriteDepsFor(process.platform);

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

/* What a read failed on, in words that quote nothing the file holds: the module's own reason for a refusal, the code of the call that failed (EACCES, EISDIR) and, for any other failure, which has no code, one fixed reason, since the message of such an error may quote what it was reading. */
export function readFailureReason(err: unknown): string {
  if (err instanceof ConfinedPathError) return err.reason;
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && code !== "" ? code : "the file could not be read";
}

/* What a refusal says when the file a descriptor is, or the directory it was made in, is not the one that was validated. */
const CHANGED = "changed between check and open";

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

/* Why a path is refused before the filesystem is asked, or undefined. The path has its separators normalized already. */
function lexicalRefusal(normalized: string): string | undefined {
  if (normalized === "") return "the path is empty";
  if (isAbsolute(normalized)) return "the path is absolute";
  if (normalized.split("/").includes("..")) return "the path has a parent-directory segment";
  return undefined;
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
  const refused = lexicalRefusal(normalized);
  if (refused !== undefined) return { reason: refused };

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
      throw new ConfinedPathError(reported, CHANGED);
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

/* ── the specs in a directory ──────────────────────────────────────────────────────────────────── */

/* A path the walk of the specs could not walk, relative to the directory it started from (empty for that directory itself), and why, in words of the module's own: never where a link points, never what a file holds. */
export interface UnwalkedPath {
  path: string;
  reason: string;
}

/* Every spec below a directory, relative to it, and every path the walk could not walk: what is behind one of those is not in `specs`, so a caller that must not let a spec go unchecked has to refuse them. */
export interface SpecTree {
  specs: string[];
  unwalked: UnwalkedPath[];
}

const LINK_TO_DIRECTORY = "is a link to a directory, which is never walked";
const LINK_UNEXAMINED = "is a link that cannot be examined";
const DIRECTORY_UNLISTED = "is a directory that cannot be listed";

/* Every *.spec.ts below `dir`, relative to it, and what could not be walked. Installed packages and dot-directories are skipped, as Playwright skips them: they are not the suite's specs. The directory is one the agent writes into, so a symbolic link in it is never walked, whatever it points at, and `dir` is not one either: no name from outside it is listed, nothing is listed twice, and a link back up cannot make the walk run away. A link to a directory is named as unwalked, since a tool that does follow it (tsc, ESLint, Playwright) would reach specs that nothing here checks, and so is a link that cannot be examined and a directory that cannot be listed; a link to nothing, or to a file that is no spec, leads to nothing to run and is left out. A file named like a spec is listed by its own name; what it points at is for the confined reader to refuse. A `dir` that is not a real directory (missing, a file, a link) has nothing to walk and is for the caller to judge. */
export function scanSpecTree(dir: string): SpecTree {
  const tree: SpecTree = { specs: [], unwalked: [] };
  try {
    /* A directory itself, not a link to one: judged by lstat of the path without a trailing separator, since `lstat("link/")` would follow the link. */
    if (!lstatSync(resolve(dir)).isDirectory()) return tree;
  } catch {
    return tree;
  }
  walkSpecFiles(dir, "", tree);
  return tree;
}

/* The specs of scanSpecTree, for a caller that has no use for the rest. */
export function listSpecFiles(dir: string): string[] {
  return scanSpecTree(dir).specs;
}

/* Each entry is told apart by what it is itself, never by what a link points at, so a link is never descended into. */
function walkSpecFiles(dir: string, rel: string, tree: SpecTree): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    tree.unwalked.push({ path: rel, reason: DIRECTORY_UNLISTED });
    return;
  }
  for (const entry of entries) {
    const entryRel = join(rel, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walkSpecFiles(join(dir, entry.name), entryRel, tree);
    } else if (entry.name.endsWith(".spec.ts")) {
      tree.specs.push(entryRel);
    } else if (entry.isSymbolicLink()) {
      const reason = unwalkedLinkReason(join(dir, entry.name));
      if (reason !== undefined) tree.unwalked.push({ path: entryRel, reason });
    }
  }
}

/* Why a link that is no spec by its name is not walked, or undefined when there is nothing behind it to walk. It is followed here for a look at what it is, and for nothing else. */
function unwalkedLinkReason(path: string): string | undefined {
  try {
    return statSync(path).isDirectory() ? LINK_TO_DIRECTORY : undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? undefined : LINK_UNEXAMINED;
  }
}

/* ── files the orchestrator keeps in the spec directory ────────────────────────────────────────── */

type Kind = "absent" | "directory" | "file" | "other" | "unreadable";

/* What a path is, by lstat, which describes a symbolic link itself and not what it points at: a link is neither a directory nor a regular file, so it is "other", like a pipe or a device. */
function kindOf(path: string): Kind {
  try {
    const stats = lstatSync(path);
    if (stats.isDirectory()) return "directory";
    return stats.isFile() ? "file" : "other";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
}

type Located = { dir: string; file: string; present: boolean };
type Owned = Located | { absent: true } | { reason: string };

/* Walks `segments` below `base`, a real directory, one lstat at a time: each must be an ordinary directory, so a symlink anywhere on the way is refused whatever it points at. With `create`, a directory that is missing is made, so nothing is absent: `mkdir` does not follow a link, and a name taken meanwhile is an error. `join` drops an empty or `.` segment, so `a//b` and `./a/b` are `a/b`. */
function walkDirectories(base: string, segments: readonly string[], create: true): { dir: string } | { reason: string };
function walkDirectories(base: string, segments: readonly string[], create: boolean): { dir: string } | { absent: true } | { reason: string };
function walkDirectories(base: string, segments: readonly string[], create: boolean): { dir: string } | { absent: true } | { reason: string } {
  let dir = base;
  for (const segment of segments) {
    const next = join(dir, segment);
    const kind = kindOf(next);
    if (kind === "absent") {
      if (!create) return { absent: true };
      mkdirSync(next);
    } else if (kind !== "directory") {
      return { reason: "a directory on the way cannot be examined, is a symbolic link or is not a directory" };
    }
    dir = next;
  }
  return { dir };
}

/* Walks `rel` below the real spec directory one lstat at a time: every directory above the file must be an ordinary directory and the file, if it is there, a regular file, so a symlink anywhere on the way is refused whatever it points at. The directories are real because the spec directory is and none of them is a link. With `create`, a directory that is missing is made (see walkDirectories). Only the directories are ever created; the file is not. */
function walkOwned(root: SpecRoot, rel: string, create: true): Located | { reason: string };
function walkOwned(root: SpecRoot, rel: string, create: false): Owned;
function walkOwned(root: SpecRoot, rel: string, create: boolean): Owned {
  const normalized = rel.replaceAll("\\", "/");
  const refused = lexicalRefusal(normalized);
  if (refused !== undefined) return { reason: refused };
  const spec = confineSpecDir(root);
  if ("reason" in spec) return spec;

  /* The directories above the file, and the file's own name. */
  const walked = walkDirectories(spec.dir, posix.dirname(normalized).split("/"), create);
  if (!("dir" in walked)) return walked;
  const file = join(walked.dir, posix.basename(normalized));
  const kind = kindOf(file);
  if (kind === "unreadable") return { reason: "the path cannot be examined" };
  if (kind === "absent" || kind === "file") return { dir: walked.dir, file, present: kind === "file" };
  return { reason: "the file is a symbolic link or not a regular file" };
}

export type OwnedDirListing = { names: string[]; truncated: boolean } | { absent: true } | { reason: string };

/* The names in a directory the orchestrator reads below the spec directory (a run of the tests leaves its output in one), walked like an owned file: no symlink anywhere on the way, whatever it points at, and the directory itself an ordinary one. Only names are returned and no entry is opened, so a named pipe in it is a name; what an entry is, and what it holds, is for the strict read of it to judge. The entries are taken one at a time and no more than `maxEntries` of them, since an agent can make a directory as large as the disk lets it: when there are more, the listing says it was cut. A refusal is a reason; a directory that is not there is absent. */
export function listOwnedSpecDir(root: SpecRoot, rel: string, maxEntries: number): OwnedDirListing {
  const normalized = rel.replaceAll("\\", "/");
  const refused = lexicalRefusal(normalized);
  if (refused !== undefined) return { reason: refused };
  const spec = confineSpecDir(root);
  if ("reason" in spec) return spec;
  const walked = walkDirectories(spec.dir, normalized.split("/"), false);
  if (!("dir" in walked)) return walked;
  try {
    const handle = opendirSync(walked.dir);
    try {
      const names: string[] = [];
      let truncated = false;
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (names.length === maxEntries) {
          truncated = true;
          break;
        }
        names.push(entry.name);
      }
      return { names: names.sort(), truncated };
    } finally {
      handle.closeSync();
    }
  } catch {
    return { reason: "the directory cannot be listed" };
  }
}

export type OwnedSpecRead = { bytes: Buffer } | { absent: true } | { reason: string };

/* The bytes of a file the orchestrator keeps at `rel` below the spec directory, read strictly (see the header) and through the confined reader, so that a swap after the check is refused too. Absent when the file or a directory above it is not there; a refusal is a reason, never the bytes of what a link points at. A failure to read a file that is there is thrown as it is. */
export function readOwnedSpecFile(root: SpecRoot, rel: string, maxBytes: number, deps: SpecReadDeps = defaultSpecReadDeps): OwnedSpecRead {
  const owned = walkOwned(root, rel, false);
  if ("reason" in owned) return owned;
  if ("absent" in owned || !owned.present) return { absent: true };
  try {
    return { bytes: readConfinedSpecBytes(root, rel, maxBytes, deps) };
  } catch (err) {
    if (err instanceof ConfinedPathError) return { reason: err.reason };
    throw err;
  }
}

/* Best-effort removal of a file this write made: the failure being thrown is the one that matters. */
function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone, or never made there */
  }
}

/* Replaces the file at `rel` below the spec directory with `text`, strictly (see the header), creating the directories above it. The text goes into a temporary file created in the same directory, exclusively and without following a link, and the temporary file is renamed over the target: a rename replaces a link at the target instead of following it, so nothing is ever written through one. Where the platform names the file a descriptor is, the temporary file must be where it was asked for; the path is walked once more after it is made, so that a directory swapped meanwhile is refused too. Throws ConfinedPathError for a refusal and the failure itself for any other; a temporary file that was made is removed on every failure, from where the platform says it is and else from where it was asked for. */
export function writeOwnedSpecFile(root: SpecRoot, rel: string, text: string, deps: SpecWriteDeps = defaultSpecWriteDeps): void {
  const owned = walkOwned(root, rel, true);
  if ("reason" in owned) throw new ConfinedPathError(rel, owned.reason);
  const temp = join(owned.dir, `${basename(owned.file)}.${deps.randomSuffix()}.tmp`);
  const fd = deps.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  let kernelPath: string | undefined;
  let written = false;
  let closing: { failure: unknown } | undefined;
  try {
    kernelPath = deps.fdPath(fd);
    if (kernelPath !== undefined && kernelPath !== temp) {
      throw new ConfinedPathError(rel, "the temporary file was created outside the spec directory");
    }
    const again = walkOwned(root, rel, false);
    if (!("dir" in again) || again.dir !== owned.dir) throw new ConfinedPathError(rel, CHANGED);
    writeFileSync(fd, text);
    written = true;
  } finally {
    /* A close that fails must neither skip the removal nor replace the failure in flight. A file whose close failed may not have been written out, so it is removed, not put in place. */
    try {
      deps.close(fd);
    } catch (failure) {
      closing = { failure };
    }
    if (!written || closing) {
      discard(temp);
      if (kernelPath !== undefined) discard(kernelPath);
    }
  }
  if (closing) throw closing.failure;
  try {
    deps.rename(temp, owned.file);
  } catch (err) {
    discard(temp);
    throw err;
  }
}
