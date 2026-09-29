/* Git hardening for every git call the engine makes on an untrusted, sandbox-touched working copy. The single definition: src/integrations/repo-mirror.ts re-exports it for the shell's own git calls. */

import { lstatSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Thrown when the git dir git would use for a working copy is not the orchestrator's own. Never swallow it into an empty result: it means untrusted code may have replaced the repository. */
export class UntrustedGitTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedGitTreeError";
  }
}

/* Write access for anyone but the owner: the group (the sandbox user may share it) and every other user. */
const WRITABLE_BEYOND_OWNER = 0o022;

function currentUid(): number | undefined {
  return typeof process.geteuid === "function" ? process.geteuid() : undefined;
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

function assertOwnedAndClosed(path: string, stat: Stats, trustedUid: number | undefined): void {
  if (trustedUid !== undefined && stat.uid !== trustedUid) refuse(path, `owned by uid ${stat.uid}, not by the orchestrator (uid ${trustedUid})`);
  if ((stat.mode & WRITABLE_BEYOND_OWNER) !== 0) refuse(path, "writable by its group or by any user");
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
 * a real directory, and it and its config owned by the orchestrator and not writable by its group or anyone else.
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
 * names another. When the platform reports no uid, ownership is not judged.
 */
export function resolveTrustedGitTree(dir: string, trustedUid: number | undefined = currentUid()): TrustedGitTree {
  const workDir = realPathOf(dir);
  for (let current = workDir; ; current = dirname(current)) {
    const gitPath = join(current, ".git");
    const stat = lstatOrNull(gitPath);
    if (stat) {
      if (stat.isSymbolicLink()) refuse(gitPath, "it is a symbolic link, not the orchestrator's own git dir");
      if (!stat.isDirectory()) refuse(gitPath, "it is a file that redirects git to another directory");
      assertOwnedAndClosed(gitPath, stat, trustedUid);
      const configPath = join(gitPath, "config");
      const config = lstatOrNull(configPath);
      if (config) {
        if (!config.isFile()) refuse(configPath, "it is not a regular file");
        assertOwnedAndClosed(configPath, config, trustedUid);
      }
      return { workDir, topLevel: current };
    }
    if (dirname(current) === current) return { workDir, topLevel: null };
  }
}

/** Refuses (UntrustedGitTreeError) unless the git dir for `dir` is the orchestrator's own. Every orchestrator write into, or delete inside, a working copy's `.git` calls this first: a planted symlink must never be written through. */
export function assertTrustedGitTree(dir: string, trustedUid: number | undefined = currentUid()): void {
  resolveTrustedGitTree(dir, trustedUid);
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
 *   check at all, since git names its git dir explicitly: a call whose answer does not depend on submodule state
 *   passes --ignore-submodules=all, or --no-recurse-submodules for a fetch.)
 * - -C <the real path of workDir> — git runs in the directory that was verified, not in whatever the path the caller
 *   holds resolves to by the time git starts. A caller's own `-C` or `cwd` for the same directory is redundant.
 * There is deliberately no override for diff.external: an empty value makes git try to run "" and fail, so the
 * config itself is what has to be trusted.
 */
export function hardenGitArgs(args: readonly string[], workDir: string): string[] {
  if (typeof workDir !== "string") throw new TypeError("hardenGitArgs needs the working copy the git call runs in");
  const tree = resolveTrustedGitTree(workDir);
  const ownership = tree.topLevel === null ? [] : ["-c", `safe.directory=${tree.topLevel}`];
  return [...baseGitHardeningFlags(), ...ownership, "-C", tree.workDir, ...args];
}
