/* The arch-lint gate forbids generation/* and agent-runtime/* from importing this file or the port (agent-is-read-only). Delegates to the injected Git fn (same boundary as repo-mirror.realGit); argv lives here. SECURITY: the injected git fn MUST prepend authHeaderArgs() before any network git operation (clone, fetch, push) and the commit-identity `-c user.name/-c user.email` flags before commit. The adapter itself is auth- and identity-agnostic (token-free, testable) — the real-wiring obligation is on the injector, not this class. The adapter stays token-agnostic so the test needs no token. A deleted tracked Dockerfile or a tracked workflow file replaced by a symlink produced EMPTY `--diff-filter=M` output while being staged and committed — same for a rename INTO a denylisted destination (status `R`, invisible to `M`). Fixed by REMOVING the status reasoning entirely: every staged path is checked against the denylist regardless of its status (no `--diff-filter` at all). A rename is parsed as a UNIT (both the old and new side) so checking either side and reverting BOTH avoids orphaning the legitimate origin as a stray staged deletion — the exact bug class `WriteConfinementService.revertUnit` already exists to prevent. */
import type { VcsWritePort } from "../application/ports/index.ts";
import { WriteConfinementService } from "../domain/write-confinement.service.ts";

export interface VcsCommitResult {
  /* Denylisted staged paths reverted before this commit — [] when nothing was denylisted (the overwhelming common case). Never fabricated: absent `denyModifiedTracked` (no guard wired) still returns [], never undefined, so callers can always safely read `.length`. */
  revertedDenylisted: string[];
  revertedDangerous: string[];
}

type Git = (args: string[], cwd?: string) => Promise<string>;
type WriteExcludesFn = (dir: string, patterns: readonly string[]) => void | Promise<void>;

export class VcsWriteAdapter implements VcsWritePort {
  private readonly pathDecoder = new WriteConfinementService();

  constructor(
    private readonly git: Git,
    private readonly writeExcludesFn?: WriteExcludesFn,
  ) {}

  async commit(
    dir: string,
    message: string,
    files: readonly string[],
    denyModifiedTracked?: (path: string) => boolean,
  ): Promise<VcsCommitResult> {
    await this.git(["add", "--", ...files], dir);
    let revertedDenylisted: string[] = [];
    if (denyModifiedTracked) {
      const diffOut = await this.git(["diff", "--cached", "--name-status", "-M"], dir);
      const denied = new Set<string>();
      for (const rawLine of diffOut.split("\n")) {
        const line = rawLine.trim();
        if (line.length === 0) continue;
        const [status, ...rest] = line.split("\t");
        if (status?.[0] === "R" && rest.length === 2) {
          const oldPath = this.pathDecoder.decodeGitPath(rest[0] as string);
          const newPath = this.pathDecoder.decodeGitPath(rest[1] as string);
          if (denyModifiedTracked(oldPath) || denyModifiedTracked(newPath)) {
            for (const p of this.pathDecoder.revertUnit(oldPath, newPath)) denied.add(p);
          }
          continue;
        }
        const path = this.pathDecoder.decodeGitPath(rest[0] ?? "");
        if (path.length > 0 && denyModifiedTracked(path)) denied.add(path);
      }
      if (denied.size > 0) {
        revertedDenylisted = [...denied];
        console.error(
          `[qa] vcs-write: a denylisted staged path was detected and reverted before commit: ${revertedDenylisted.join(", ")}`,
        );
        await this.git(["restore", "--staged", "--worktree", "--source=HEAD", "--", ...revertedDenylisted], dir);
      }
    }
    try {
      await this.git(["commit", "-m", message], dir);
    } catch (err) {
      if (revertedDenylisted.length > 0) {
        const original = err instanceof Error ? err.message : String(err);
        throw new Error(
          `commit blocked: every staged change was denylisted by the tracked-file security guard and reverted (${revertedDenylisted.join(", ")}) — nothing legitimate remained to commit. Original git error: ${original}`,
        );
      }
      throw err;
    }
    const revertedDangerous = revertedDenylisted.filter((p) => this.pathDecoder.isDangerousPath(p));
    return { revertedDenylisted, revertedDangerous };
  }

  async push(dir: string, branch: string): Promise<void> {
    await this.git(["push", "--force-with-lease", "-u", "origin", branch], dir);
  }

  async checkoutBranch(dir: string, branch: string): Promise<void> {
    await this.git(["checkout", "-B", branch], dir);
  }

  async hasChanges(dir: string, pathspecs: readonly string[]): Promise<boolean> {
    const status = await this.git(["status", "--porcelain", "--", ...pathspecs], dir);
    return status.trim().length > 0;
  }

  async writeExcludes(dir: string, patterns: readonly string[]): Promise<void> {
    if (!this.writeExcludesFn) return;
    await this.writeExcludesFn(dir, patterns);
  }
}
