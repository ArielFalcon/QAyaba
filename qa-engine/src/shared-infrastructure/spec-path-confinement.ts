/* The one reader of a path an agent reported. The agent writes the suite's spec files and names them in its verdict, so a reported name is untrusted input: it can be absolute, climb out with `..`, or be a symlink or a named pipe the agent planted. Every orchestrator read or probe of such a reported name goes through here (the generation port's spec sources and the specs it hands a regeneration, the reviewer's inlining, the review DOM grounding, the manifest's file hashes, the sidekick's claimed files and the pre-exec capture), anchored on the real location of the mirror, and none of them follows a link out of the spec directory or reads anything but the regular file it validated. A file is judged by lstat before it is opened, so a named pipe or a device is not opened on purpose.
   The path can still be swapped between that check and the open by a process the agent left running, and O_NOFOLLOW covers only the last component, so the descriptor is judged as well. Where the platform can name the file a descriptor really is (Linux, through procfs), that kernel path must lie inside the spec directory: it does not depend on any path being walked again, and it closes the window for every file the agent cannot move into the spec directory, which is every file outside the volume it shares with the orchestrator. Where the platform cannot (macOS), the descriptor's device and inode must equal those of the file validated before the open and again after it: that narrows the window to a process flipping the path at exactly the right instants, and does not close it. Hard links stay out of scope. A file is read whole or not at all.
   The orchestrator also reads, lists and keeps files in that directory that no verdict names, where the agent can plant a link at the file or at the directory above it, a named pipe, or a file or a directory of any size. Those are read, listed, made and written strictly, by `readOwnedSpecFile`, `listOwnedSpecDir`, `ensureOwnedSpecDir` and `writeOwnedSpecFile` (and what keeps one of them from being read for good, because it survives from one run to the next, is removed without being opened or followed by `purgeRefusedPath`, and a directory of the orchestrator's own that is not an ordinary one by `purgeRefusedDirectory`): no symlink anywhere below the spec directory, a regular file at the end of a path (an ordinary directory, listed entry by entry up to a cap, for a directory), a read under a cap, and a write that goes through an exclusively created temporary file renamed over the target, never through a link. A directory is judged by its path before it is opened and is not looked at again, since only its names are taken: a swap in that window can show the names of another directory, never what an entry holds, because every entry is then read through the strict read of its own.
   Exactly what goes through here. The reported names above. The manifest and the context map, in `.qa`. What setup reads and replaces in the project directory: the fixtures file, the ignore file, the login setup, the Playwright config, the lock file and the install marker (which `git clean -fd -e node_modules` leaves in place from one run to the next), and the entries of `.qa` that the project's .gitignore keeps git from cleaning (the coverage and fault-injection directories and the measured file: what is not an ordinary directory or file there is removed, so a plant cannot refuse every later read of what a run leaves in them). The login's stock check of `auth.setup.ts`. What a run of the tests leaves for the orchestrator to read: the coverage dumps under `.qa/coverage`, the native coverage reports of a code run (lcov, Istanbul, JaCoCo), the fault-injection counters under `.qa/fault-injection`, the Playwright report and the failure-capture dumps that the e2e runner reads back from the temporary directories it makes for a run of the tests, and the report of the mutation oracle. What a code run reads of the working copy (the manifest that names its test command) and writes into it (the oracle's config). The specs that the read gate scans and the grounding lists, which are listed without following a link and looking at no more than a cap of entries (`scanSpecTree`, `listSpecFiles`) and read like a reported name; what the walk could not walk (a link to a directory, a directory it could not list, a directory it was cut in) is named, and the read gate refuses it. The files of a repository's mirror that the topology resolvers read (`walkRepoFiles`, then the strict read of each) and that the staging of a service's context lists, reads and stages, into the front's working copy, which is written through the strict calls too. There is no analysis map to read: the agent writes `.qa/analysis.json` and no orchestrator code opens it. Not read through here: the fixtures file read for harness facts, which has an open of its own that neither follows a link nor waits on a pipe.
   Known limits, recorded and not closed. A removal names its entry by a path joined from the real spec directory and the names found by lstat, so a process that swaps a directory on the way for a link between the look and the removal can have a like-named entry in another directory removed or set aside (the window the reads have, here for a removal). The orchestrator also removes trees the agent wrote with a recursive `rmSync` where it owns the directory (the staging directory of a service's context, the temporary directories of a run, what the mutation oracle leaves): `rmSync` does not follow a link, and it is not bounded in time or in depth. A document the agent writes is parsed in the orchestrator's one thread under a cap on its size (the Playwright report, the coverage dumps, the oracle's report), which bounds what it costs by the cap and not by what it holds: a document of nothing but empty arrays takes a second and a quarter of a gigabyte for every 16 MiB. And the report and the dumps are written by code the agent wrote, so what they say can be forged: only the reading of them is bounded.
   Synchronous, and it lives in shared-infrastructure because the kernel holds no fs code and several contexts need it. */

import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, opendirSync, openSync, readSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, type Dir, type Dirent } from "node:fs";
import { basename, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

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

/* The most directory entries one walk looks at, all the directories it walks together: a suite is some hundreds of specs and the files that go with them, so this is far beyond any real one. */
export const MAX_SPEC_WALK_ENTRIES = 20_000;
const LINK_TO_DIRECTORY = "is a link to a directory, which is never walked";
const LINK_UNEXAMINED = "is a link that cannot be examined";
const DIRECTORY_UNLISTED = "is a directory that cannot be listed";

/* Every *.spec.ts below `dir`, relative to it, and what could not be walked. Installed packages and dot-directories are skipped, as Playwright skips them: they are not the suite's specs. The directory is one the agent writes into, so a symbolic link in it is never walked, whatever it points at, and `dir` is not one either: no name from outside it is listed, nothing is listed twice, and a link back up cannot make the walk run away. A link to a directory is named as unwalked, since a tool that does follow it (tsc, ESLint, Playwright) would reach specs that nothing here checks, and so is a link that cannot be examined and a directory that cannot be listed; a link to nothing, or to a file that is no spec, leads to nothing to run and is left out. A file named like a spec is listed by its own name; what it points at is for the confined reader to refuse. A `dir` that is not a real directory (missing, a file, a link) has nothing to walk and is for the caller to judge. The agent can also make a directory as large as the disk lets it, so the directories are read entry by entry and no more than `maxEntries` entries are looked at in all: a directory with entries past that is named as unwalked, as is every directory reached once the cap is spent, since none of their entries was looked at. */
export function scanSpecTree(dir: string, maxEntries: number = MAX_SPEC_WALK_ENTRIES): SpecTree {
  const tree: SpecTree = { specs: [], unwalked: [] };
  try {
    /* A directory itself, not a link to one: judged by lstat of the path without a trailing separator, since `lstat("link/")` would follow the link. */
    if (!lstatSync(resolve(dir)).isDirectory()) return tree;
  } catch {
    return tree;
  }
  walkSpecFiles(dir, "", tree, { left: maxEntries, cap: maxEntries });
  return tree;
}

/* The specs of scanSpecTree, for a caller that has no use for the rest. */
export function listSpecFiles(dir: string): string[] {
  return scanSpecTree(dir).specs;
}

/* How many entries a walk may still look at, and how many it was given. */
interface WalkBudget {
  left: number;
  cap: number;
}

/* The entries of a directory, taken one at a time and no more than the walk has left to look at: `cut` says there were more. A directory that cannot be opened or read to its end is undefined, since half a listing is not one. */
function readWalkEntries(dir: string, budget: WalkBudget): { entries: Dirent[]; cut: boolean } | undefined {
  let handle: Dir;
  try {
    handle = opendirSync(dir);
  } catch {
    return undefined;
  }
  try {
    const entries: Dirent[] = [];
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (budget.left === 0) return { entries, cut: true };
      budget.left -= 1;
      entries.push(entry);
    }
    return { entries, cut: false };
  } catch {
    return undefined;
  } finally {
    handle.closeSync();
  }
}

/* Each entry is told apart by what it is itself, never by what a link points at, so a link is never descended into. */
function walkSpecFiles(dir: string, rel: string, tree: SpecTree, budget: WalkBudget): void {
  const read = readWalkEntries(dir, budget);
  if (read === undefined) {
    tree.unwalked.push({ path: rel, reason: DIRECTORY_UNLISTED });
    return;
  }
  if (read.cut) tree.unwalked.push({ path: rel, reason: `holds more entries than the ${budget.cap} the walk looks at in all, so not all of them are walked` });
  for (const entry of read.entries) {
    const entryRel = join(rel, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walkSpecFiles(join(dir, entry.name), entryRel, tree, budget);
    } else if (entry.name.endsWith(".spec.ts")) {
      tree.specs.push(entryRel);
    } else if (entry.isSymbolicLink()) {
      const reason = unwalkedLinkReason(join(dir, entry.name));
      if (reason !== undefined) tree.unwalked.push({ path: entryRel, reason });
    }
  }
}

/* What a walk of a repository's files is held to: the entries it looks at in all, and the files it takes. Far beyond any repository (a very large monorepo is some hundreds of thousands of entries once its installed packages are left out). */
export interface RepoWalkLimits {
  maxEntries: number;
  maxFiles: number;
}

export const REPO_WALK_LIMITS: RepoWalkLimits = { maxEntries: 500_000, maxFiles: 200_000 };

/* The files a walk of a repository's mirror took, relative to its root and "/"-separated, in the order of the names: `cut` says that entries or files past the limits were not looked at, `unlisted` how many directories could not be listed, `odd` how many entries were neither a directory, a regular file nor a link (a named pipe, a socket, a device: none belongs in a repository, so they are counted, while a link is an ordinary thing and is not), and `refused` why the root itself was not walked (it is a link or no directory). */
export interface RepoWalk {
  files: string[];
  cut: boolean;
  unlisted: number;
  odd: number;
  refused?: string;
}

/* The regular files of a repository's mirror that `accept` takes (given the file's name and its path below `root`), for a caller that reads them for something other than the suite: a topology resolver, the staging of a service's context. The mirror is a directory the agent writes into, and a repository's tree can hold committed links, so each entry is told apart by what it is itself and never by what a link points at: a directory is entered (unless it is one of `skipDirs`), a regular file is offered to `accept`, and a link, a named pipe or anything else is neither, so a link back up cannot make the walk run away and nothing outside the root is listed or opened. The directories are read entry by entry and no more than `limits.maxEntries` of them are looked at in all, and no more than `limits.maxFiles` files are taken, so that a directory as large as the disk lets it be cannot fill the memory or the time of the orchestrator. The entries of a directory are visited in the order of their names, so what the walk finds does not depend on the filesystem. The files are read, one by one, through readOwnedSpecFile, which judges each again. */
export function walkRepoFiles(root: string, accept: (name: string, rel: string) => boolean, skipDirs: ReadonlySet<string>, limits: RepoWalkLimits = REPO_WALK_LIMITS): RepoWalk {
  const walk: RepoWalk = { files: [], cut: false, unlisted: 0, odd: 0 };
  const start = resolve(root);
  try {
    const stats = lstatSync(start);
    if (!stats.isDirectory()) {
      walk.refused = stats.isSymbolicLink() ? "the repository directory is a symbolic link" : "the repository directory is not a directory";
      return walk;
    }
  } catch {
    return walk;
  }
  const budget: WalkBudget = { left: limits.maxEntries, cap: limits.maxEntries };
  const visit = (dir: string, rel: string): void => {
    const read = readWalkEntries(dir, budget);
    if (read === undefined) {
      walk.unlisted += 1;
      return;
    }
    if (read.cut) walk.cut = true;
    const byName = new Map(read.entries.map((entry) => [entry.name, entry]));
    for (const name of [...byName.keys()].sort()) {
      const entry = byName.get(name)!;
      const entryRel = rel === "" ? name : `${rel}/${name}`;
      if (entry.isDirectory()) {
        if (!skipDirs.has(name)) visit(join(dir, name), entryRel);
      } else if (entry.isFile()) {
        if (!accept(name, entryRel)) continue;
        if (walk.files.length >= limits.maxFiles) {
          walk.cut = true;
          return;
        }
        walk.files.push(entryRel);
      } else if (!entry.isSymbolicLink()) {
        walk.odd += 1;
      }
    }
  };
  visit(start, "");
  return walk;
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

/* Makes the directory at `rel` below the spec directory, and the ordinary directories above it that are not there yet, strictly (see the header), and leaves one that is there as it is. Nothing is made through a link: a directory on the way, or the one asked for, that is a link, a named pipe or a file is refused. Throws ConfinedPathError for a refusal and the failure itself for any other. */
export function ensureOwnedSpecDir(root: SpecRoot, rel: string): void {
  const normalized = rel.replaceAll("\\", "/");
  const refused = lexicalRefusal(normalized);
  if (refused !== undefined) throw new ConfinedPathError(rel, refused);
  const spec = confineSpecDir(root);
  if ("reason" in spec) throw new ConfinedPathError(rel, spec.reason);
  const walked = walkDirectories(spec.dir, normalized.split("/"), true);
  if ("reason" in walked) throw new ConfinedPathError(rel, walked.reason);
}

/* Replaces the file at `rel` below the spec directory with `text`, strictly (see the header), creating the directories above it. The text goes into a temporary file created in the same directory, exclusively and without following a link, and the temporary file is renamed over the target: a rename replaces a link at the target instead of following it, so nothing is ever written through one. Where the platform names the file a descriptor is, the temporary file must be where it was asked for; the path is walked once more after it is made, so that a directory swapped meanwhile is refused too. Throws ConfinedPathError for a refusal and the failure itself for any other; a temporary file that was made is removed on every failure, from where the platform says it is and else from where it was asked for. The text is a string, or the bytes of a file that need not be text. */
export function writeOwnedSpecFile(root: SpecRoot, rel: string, text: string | Uint8Array, deps: SpecWriteDeps = defaultSpecWriteDeps): void {
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

/* ── removing what refuses the strict read ─────────────────────────────────────────────────────── */

/* What a path is by lstat, which describes a link itself and not what it points at. */
export interface PurgeStat {
  isDirectory(): boolean;
  isFile(): boolean;
  size: number | bigint;
}

/* The calls a purge makes: what an entry is (undefined when nothing is there), the removal of a name, the rename that sets a directory aside, and the name it gets. Real in production; a test makes a call fail. */
export interface SpecPurgeDeps {
  lstat(path: string): PurgeStat | undefined;
  unlink(path: string): void;
  rename(from: string, to: string): void;
  randomSuffix(): string;
}

export const defaultSpecPurgeDeps: SpecPurgeDeps = {
  lstat: (path) => {
    try {
      return lstatSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  },
  unlink: (path) => unlinkSync(path),
  rename: (from, to) => renameSync(from, to),
  randomSuffix: () => randomBytes(4).toString("hex"),
};

/* What a purge did: the entry it removed, as a path below the spec directory, and how, or that there was nothing to remove. */
export type PurgeResult = { removed: string; how: "unlinked" | "set aside" } | { nothing: true };

/* Whatever ends the call, a name that is gone is a name that is free. */
function ignoreGone(run: () => void): void {
  try {
    run();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/* Removes what keeps the strict read of `rel` below the spec directory from vouching for it, so that a read that was refused can be tried again, and nothing else. It walks the path from the real spec directory one lstat at a time and stops at the first entry that is not what the read needs: a directory above the file that is a link, a named pipe, a socket, a device or a file, or the file itself when it is no regular file or is over `maxBytes`. That entry is the one that goes, and it goes without being opened or followed: a link, a pipe and the rest are unlinked (the name goes, a link's target is not touched), and a directory is set aside by a rename in its own parent (nothing below it is read or deleted). A regular file within the cap, an ordinary path and a path that is not there are not what refused the read: nothing is removed. Nothing outside the spec directory can be reached, since every name removed is one found by lstat under a directory that was itself found to be an ordinary one. Throws ConfinedPathError for a spec directory or a path that is refused, and any failure of a call as it is. */
export function purgeRefusedPath(root: SpecRoot, rel: string, maxBytes: number, deps: SpecPurgeDeps = defaultSpecPurgeDeps): PurgeResult {
  return purgeFirstRefused(root, rel, deps, (stats) => stats.isFile() && Number(stats.size) <= maxBytes);
}

/* The same for a directory the orchestrator owns, one that the runs make and that `git clean -fd` leaves in place because git ignores it (`.qa/coverage`, `.qa/fault-injection`): what is wanted at `rel` is an ordinary directory, with whatever is in it, so an ordinary directory is left as it is and is never set aside. What is there instead (a link, a named pipe, a socket, a device, a regular file) is unlinked without being opened or followed, and so is a directory above it that is not an ordinary one; the run then makes the directory again. Nothing is made here. */
export function purgeRefusedDirectory(root: SpecRoot, rel: string, deps: SpecPurgeDeps = defaultSpecPurgeDeps): PurgeResult {
  return purgeFirstRefused(root, rel, deps, (stats) => stats.isDirectory());
}

/* The walk both purges are: the first entry of `rel` that is not an ordinary directory above its last segment, or not what `leavesAlone` accepts at the last, is the one that goes. */
function purgeFirstRefused(root: SpecRoot, rel: string, deps: SpecPurgeDeps, leavesAlone: (stats: PurgeStat) => boolean): PurgeResult {
  const normalized = rel.replaceAll("\\", "/");
  const refused = lexicalRefusal(normalized);
  if (refused !== undefined) throw new ConfinedPathError(rel, refused);
  const spec = confineSpecDir(root);
  if ("reason" in spec) throw new ConfinedPathError(rel, spec.reason);

  /* An empty or `.` segment is no step of the path, as everywhere in this module: it names the directory it is in, which is never the entry to remove. */
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  let dir = spec.dir;
  for (const [index, segment] of segments.entries()) {
    const entry = join(dir, segment);
    const stats = deps.lstat(entry);
    if (stats === undefined) return { nothing: true };
    const last = index === segments.length - 1;
    if (stats.isDirectory() && !last) {
      dir = entry;
      continue;
    }
    if (last && leavesAlone(stats)) return { nothing: true };
    const removed = relative(spec.dir, entry).split(sep).join("/");
    if (stats.isDirectory()) {
      ignoreGone(() => deps.rename(entry, join(dir, `${segment}.refused-${deps.randomSuffix()}`)));
      return { removed, how: "set aside" };
    }
    ignoreGone(() => deps.unlink(entry));
    return { removed, how: "unlinked" };
  }
  return { nothing: true };
}
