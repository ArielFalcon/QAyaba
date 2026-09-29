/* Git hardening for every git call the engine makes on an untrusted, sandbox-touched working copy. The single definition: src/integrations/repo-mirror.ts re-exports it for the shell's own git calls. */

import { lstatSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Thrown when the git dir git would use for a working copy is not the orchestrator's own. Never swallow it into an empty result: it means untrusted code may have replaced the repository. */
export class UntrustedGitTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedGitTreeError";
  }
}

const OTHER_WRITABLE = 0o002;

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

function assertOwnedAndClosed(path: string, stat: Stats, trustedUid: number | undefined): void {
  if (trustedUid !== undefined && stat.uid !== trustedUid) refuse(path, `owned by uid ${stat.uid}, not by the orchestrator (uid ${trustedUid})`);
  if ((stat.mode & OTHER_WRITABLE) !== 0) refuse(path, "writable by any user");
}

/**
 * Verify the git dir git would discover for `dir` (the nearest `.git` at or above it) is the orchestrator's own:
 * a real directory, and it and its config owned by the orchestrator and not world-writable.
 *
 * A code/e2e run hands the working copy to the unprivileged sandbox user, and `.git` is chowned back to the
 * orchestrator. The sandbox user still owns the directory that CONTAINS `.git`, so it can rename it and `git init`
 * a `.git` of its own, or leave a symlink or gitfile in its place. Its config could name a command (core.fsmonitor,
 * diff.external, a filter driver) that the next root git call runs. Git's own "dubious ownership" check is the
 * guard against exactly that, and `safe.directory=*` opts out of it, so this check takes its place. With no `.git`
 * at or above `dir` there is nothing for git to run against (it refuses on its own; implicit bare repositories are
 * refused by the flags below), so the check passes.
 *
 * `trustedUid` is the owner the git dir must have: the orchestrator's effective uid unless a caller (a test)
 * names another. When the platform reports no uid, ownership is not judged.
 */
export function assertTrustedGitTree(dir: string, trustedUid: number | undefined = currentUid()): void {
  for (let current = resolve(dir); ; current = dirname(current)) {
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
      return;
    }
    if (dirname(current) === current) return;
  }
}

/**
 * Hardened argv for a git call. `workDir` is the working copy the call runs in, or null for a call with none yet
 * (a clone, an ls-remote); a working copy whose git dir is not the orchestrator's throws UntrustedGitTreeError
 * before any git process starts.
 *
 * The flags are COMMAND-LINE `-c` overrides, which a repo's own .git/config cannot override, and which git passes on
 * to the child processes it starts (submodule status):
 * - core.hooksPath=/dev/null — a hook planted by the sandbox would otherwise run as the orchestrator.
 * - safe.directory=* — a code/e2e run hands the working copy to the unprivileged sandbox uid, so git run as the
 *   orchestrator would reject the tree ("dubious ownership") on the next run. Sound only together with
 *   assertTrustedGitTree, which asks the same question with the orchestrator as the trusted owner.
 * - core.fsmonitor=false — a config-named fsmonitor command would otherwise run on every status/checkout/add.
 * - safe.bareRepository=explicit — a bare repository planted in a subdirectory is never discovered implicitly.
 * There is deliberately no override for diff.external: an empty value makes git try to run "" and fail, so the
 * config itself is what has to be trusted.
 */
export function hardenGitArgs(args: readonly string[], workDir: string | null): string[] {
  if (workDir !== null) assertTrustedGitTree(workDir);
  return ["-c", "core.hooksPath=/dev/null", "-c", "safe.directory=*", "-c", "core.fsmonitor=false", "-c", "safe.bareRepository=explicit", ...args];
}
