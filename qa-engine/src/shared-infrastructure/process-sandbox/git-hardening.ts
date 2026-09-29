/* Git hardening for every git call the engine makes on an untrusted, sandbox-touched working copy. The single definition: src/integrations/repo-mirror.ts re-exports it for the shell's own git calls. */

import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Thrown when the git dir git would use for a working copy is not the orchestrator's own. Never swallow it into an empty result: it means untrusted code may have replaced the repository. */
export class UntrustedGitTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedGitTreeError";
  }
}

/* Write access for every user who is neither the owner nor in the file's group. */
const WRITABLE_BY_OTHERS = 0o002;
/* Write access for the file's group. */
const WRITABLE_BY_GROUP = 0o020;

function currentUid(): number | undefined {
  return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

function currentGid(): number | undefined {
  return typeof process.getegid === "function" ? process.getegid() : undefined;
}

/* The group the unprivileged sandbox user runs as, when there is one (it may be the orchestrator's own group, even gid 0). */
let sandboxGid: number | undefined;

/**
 * Names the group the sandbox user runs as, or undefined when there is no sandbox. The composition root calls it once
 * with the identity it resolved. A git dir writable by that group is never trusted, even when the group is also the
 * orchestrator's own: the sandbox could rewrite its config.
 */
export function setSandboxGroup(gid: number | undefined): void {
  sandboxGid = gid;
}

function refuse(path: string, why: string): never {
  throw new UntrustedGitTreeError(`refusing to run git on ${path}: ${why}`);
}

/** null when the entry does not exist (or a parent is not a directory); any other failure means the entry cannot be judged, so it is refused. */
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return refuse(path, `cannot be inspected (${code ?? "unknown error"})`);
  }
}

/**
 * The real path of `path`: every symlink along it resolved. A path that does not exist (yet) is resolved through its
 * nearest existing ancestor, so a working copy that is about to be cloned still yields a stable answer.
 */
function realPathOf(path: string): string {
  const missing: string[] = [];
  for (let existing = resolve(path); ; existing = dirname(existing)) {
    try {
      return join(realpathSync(existing), ...[...missing].reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return refuse(path, `cannot be resolved (${code ?? "unknown error"})`);
      if (dirname(existing) === existing) return refuse(path, "cannot be resolved (no part of it exists)");
      missing.push(basename(existing));
    }
  }
}

/**
 * `path` (a git dir or its config) must be owned by the orchestrator and closed to everyone who could rewrite it: no
 * user outside its group may write it, and neither may its group unless that group is the orchestrator's own and not
 * the sandbox's. A host whose umask is 002 creates every git dir group-writable in the creating user's own group, which
 * is the orchestrator's own group and nobody else's.
 */
function assertOwnedAndClosed(path: string, stat: Stats, gitPath: string, trustedUid: number | undefined, trustedGid: number | undefined): void {
  if (trustedUid !== undefined && stat.uid !== trustedUid) refuse(path, `owned by uid ${stat.uid}, not by the orchestrator (uid ${trustedUid})`);
  const close = `close it with: chmod -R g-w ${gitPath}`;
  if ((stat.mode & WRITABLE_BY_OTHERS) !== 0) refuse(path, `writable by any user (${close})`);
  if ((stat.mode & WRITABLE_BY_GROUP) === 0) return;
  if (trustedGid === undefined || stat.gid !== trustedGid) refuse(path, `writable by its group (gid ${stat.gid}), which is not the orchestrator's own (${close})`);
  if (stat.gid === sandboxGid) refuse(path, `writable by its group (gid ${stat.gid}), which the sandbox user runs as (${close})`);
}

/** Where a hardened git call runs: the working copy and the git dir it was judged against, both as real paths. */
export interface TrustedGitTree {
  /** The real path of the directory git runs in. */
  workDir: string;
  /** The real path of the directory holding the verified `.git` (git's worktree top level), or null when there is no git dir at or above `workDir`. */
  topLevel: string | null;
}

/**
 * Verify the git dir git would discover for `dir` (the nearest `.git` at or above it) is the orchestrator's own:
 * a real directory, and it and its config owned by the orchestrator and not writable by anyone else; its own group may
 * write them (a umask-002 host creates them that way) unless the sandbox user runs as that group.
 * Returns the real paths the verdict is about, so the caller runs git on exactly those and not on the path it was given.
 *
 * A code/e2e run hands the working copy to the unprivileged sandbox user, and `.git` is chowned back to the
 * orchestrator. The sandbox user still owns the directory that CONTAINS `.git`, so it can rename it and `git init`
 * a `.git` of its own, or leave a symlink or gitfile in its place. Its config could name a command (core.fsmonitor,
 * diff.external, a filter driver) that the next root git call runs. Git's own "dubious ownership" check is the
 * guard against exactly that, so this check asks the same question with the orchestrator as the trusted owner. With
 * no `.git` at or above `dir` there is nothing for git to run against (it refuses on its own; implicit bare
 * repositories are refused by the flags in hardenGitArgs), so the check passes.
 *
 * The walk starts from the REAL path of `dir`: git discovers the repository from the directory it really runs in, so
 * a symlinked path component (a link inside the working copy to a directory of a repository the sandbox controls)
 * must not let the check judge one repository while git runs in another.
 *
 * A `.git` FILE (a submodule checkout or a linked worktree) is refused outright: it redirects git to a directory the
 * walk does not vouch for. Watched-repo mirrors are plain clones, so a gitfile there is never legitimate.
 *
 * `trustedUid` is the owner the git dir must have: the orchestrator's effective uid unless a caller (a test)
 * names another. When the platform reports no uid, ownership is not judged. `trustedGid` is the orchestrator's own
 * group likewise; when the platform reports none, a group-writable git dir is refused.
 */
export function resolveTrustedGitTree(dir: string, trustedUid: number | undefined = currentUid(), trustedGid: number | undefined = currentGid()): TrustedGitTree {
  const workDir = realPathOf(dir);
  for (let current = workDir; ; current = dirname(current)) {
    const gitPath = join(current, ".git");
    const stat = lstatOrNull(gitPath);
    if (stat) {
      if (stat.isSymbolicLink()) refuse(gitPath, "it is a symbolic link, not the orchestrator's own git dir");
      if (!stat.isDirectory()) refuse(gitPath, "it is a file that redirects git to another directory");
      assertOwnedAndClosed(gitPath, stat, gitPath, trustedUid, trustedGid);
      const configPath = join(gitPath, "config");
      const config = lstatOrNull(configPath);
      if (config) {
        if (!config.isFile()) refuse(configPath, "it is not a regular file");
        assertOwnedAndClosed(configPath, config, gitPath, trustedUid, trustedGid);
      }
      return { workDir, topLevel: current };
    }
    if (dirname(current) === current) return { workDir, topLevel: null };
  }
}

/** Refuses (UntrustedGitTreeError) unless the git dir for `dir` is the orchestrator's own. Every orchestrator write into, or delete inside, a working copy's `.git` calls this first: a planted symlink must never be written through. */
export function assertTrustedGitTree(dir: string, trustedUid: number | undefined = currentUid(), trustedGid: number | undefined = currentGid()): void {
  resolveTrustedGitTree(dir, trustedUid, trustedGid);
}

/* The mode git records for a submodule entry (a gitlink) in the index. */
const GITLINK_MODE = "160000";

/* Room for the index listing of a very large repository; a listing that still overflows is refused, never truncated. */
const LS_FILES_MAX_BUFFER = 512 * 1024 * 1024;

/** The paths, relative to `topLevel`, of the submodule entries in its index. Reads the index only: no submodule is entered and no filter runs. */
function committedGitlinks(topLevel: string): string[] {
  let listing: string;
  try {
    listing = execFileSync("git", [...baseGitHardeningFlags(), "-c", `safe.directory=${topLevel}`, "-C", topLevel, "ls-files", "--stage", "-z"], {
      encoding: "utf8",
      maxBuffer: LS_FILES_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return refuse(topLevel, `its submodule entries cannot be listed (${(err as NodeJS.ErrnoException).code ?? "git failed"})`);
  }
  const gitlinks: string[] = [];
  for (const entry of listing.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    if (entry.startsWith(`${GITLINK_MODE} `)) gitlinks.push(entry.slice(tab + 1));
  }
  return gitlinks;
}

/**
 * Refuses (UntrustedGitTreeError) when a committed submodule directory of the working copy holds a `.git` of any kind.
 * A watched repository can commit a gitlink; the mirror is a plain clone that never checks a submodule out, so the
 * gitlink's directory is empty, and the sandbox that owns the working copy can put a repository of its own in it. Root
 * git that then walks the tree (status, diff, add, checkout, ...) starts a child inside it with GIT_DIR named
 * explicitly, so git's ownership check never applies, and that child runs the filter or fsmonitor command the planted
 * config names as the orchestrator. Some calls can be told not to look (--ignore-submodules); `add` cannot, so no git
 * runs on a working copy that holds a planted one.
 */
function assertNoPlantedSubmoduleRepositories(topLevel: string): void {
  for (const gitlink of committedGitlinks(topLevel)) {
    const nested = join(topLevel, gitlink, ".git");
    if (lstatOrNull(nested) !== null) {
      refuse(nested, `it sits inside the submodule directory ${gitlink}, which a working copy here never checks out: the sandbox planted it, and git would run its config as the orchestrator. Remove ${join(topLevel, gitlink)} to recover`);
    }
  }
}

/** The command-line flags every hardened git call carries, with or without a working copy. */
export function baseGitHardeningFlags(): string[] {
  return ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "safe.bareRepository=explicit"];
}

/**
 * Hardened argv for a git call that runs in `workDir`, the working copy: a working copy whose git dir is not the
 * orchestrator's throws UntrustedGitTreeError before any git process starts. `workDir` is required, and a caller with
 * none (null, undefined) is refused: the only git calls that have no working copy yet (a clone, an ls-remote) use
 * hardenDetachedGitArgs, a separate module the engine may not import.
 *
 * The flags are COMMAND-LINE `-c` overrides, which a repo's own .git/config cannot override, and which git passes on
 * to the child processes it starts (submodule status):
 * - core.hooksPath=/dev/null — a hook planted by the sandbox would otherwise run as the orchestrator.
 * - core.fsmonitor=false — a config-named fsmonitor command would otherwise run on every status/checkout/add.
 * - safe.bareRepository=explicit — a bare repository planted in a subdirectory is never discovered implicitly.
 * - safe.directory=<the verified worktree top level> — a code/e2e run hands the working copy to the unprivileged
 *   sandbox uid, so git run as the orchestrator would reject the tree ("dubious ownership") on the next run. Only the
 *   tree assertTrustedGitTree judged is opted out, so another repository reached with the same flags keeps git's own
 *   ownership check instead of being trusted with a wildcard. (A submodule git enters itself is not covered by that
 *   check at all, since git names its git dir explicitly: a working copy whose committed submodule directory holds
 *   a `.git` is refused before any git runs, and a call whose answer does not depend on submodule state also passes
 *   --ignore-submodules, or --no-recurse-submodules for a fetch.)
 * - -C <the real path of workDir> — git runs in the directory that was verified, not in whatever the path the caller
 *   holds resolves to by the time git starts. A caller's own `-C` or `cwd` for the same directory is redundant.
 * There is deliberately no override for diff.external: an empty value makes git try to run "" and fail, so the
 * config itself is what has to be trusted.
 */
export function hardenGitArgs(args: readonly string[], workDir: string): string[] {
  if (typeof workDir !== "string") throw new TypeError("hardenGitArgs needs the working copy the git call runs in");
  const tree = resolveTrustedGitTree(workDir);
  if (tree.topLevel !== null) assertNoPlantedSubmoduleRepositories(tree.topLevel);
  const ownership = tree.topLevel === null ? [] : ["-c", `safe.directory=${tree.topLevel}`];
  return [...baseGitHardeningFlags(), ...ownership, "-C", tree.workDir, ...args];
}
