import { basename, dirname, join, resolve } from "node:path";
import { assertTrustedGitTree, UntrustedGitTreeError } from "../../../shared-infrastructure/process-sandbox/git-hardening.ts";

export type Git = (args: string[], cwd?: string) => Promise<string>;

export interface MirrorProvisionDeps {
  git: Git;
  exists(path: string): boolean;
  removeFile(path: string): void;
  /** Deletes a directory tree without following a link inside it or the directory itself being one. Unwired, a mirror whose git dir is refused stays refused until an operator deletes it. */
  removeTree?(path: string): void;
  remoteUrl(repo: string): string;
  root: string;
}

const HEX_SHA = /^[0-9a-f]{7,40}$/i;
function assertHexSha(sha: string): void {
  if (!HEX_SHA.test(sha)) throw new Error(`invalid commit sha (must be 7–40 hex chars): ${JSON.stringify(sha)}`);
}

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
function assertBranchName(branch: string): void {
  if (!BRANCH_RE.test(branch) || branch.includes("..")) {
    throw new Error(`invalid branch name: ${JSON.stringify(branch)}`);
  }
}

export class MirrorProvisionAdapter {
  constructor(private readonly deps: MirrorProvisionDeps) {}

  async ensureMirror(repo: string, sha: string): Promise<string> {
    assertHexSha(sha);
    return this.provision(repo, sha);
  }

  async ensureMirrorAtBranch(repo: string, branch: string): Promise<string> {
    assertBranchName(branch);
    return this.provision(repo, `origin/${branch}`);
  }

  private mirrorDir(repo: string): string {
    return join(this.deps.root, repo.replaceAll("/", "__"));
  }

  /**
   * Syncs the mirror and checks `rev` out. A mirror is a regenerable cache, and the sandbox that owns its directory can
   * leave it in a state the git hardening refuses for good (a repository planted under it, a swapped git dir). Git is
   * never run inside such a tree to repair it: it is deleted, and the mirror cloned afresh, once. A refusal that
   * survives the fresh clone is real and propagates.
   */
  private async provision(repo: string, rev: string): Promise<string> {
    const dir = this.mirrorDir(repo);
    const existed = this.deps.exists(dir);
    try {
      return await this.syncAndCheckout(repo, rev);
    } catch (err) {
      if (!(err instanceof UntrustedGitTreeError) || !existed || !this.deps.removeTree || !this.isDirectChildOfRoot(dir)) throw err;
      console.error(`[qa] mirror ${dir} is not usable (${err.message}); it is a regenerable cache, so it is deleted and cloned afresh`);
      this.deps.removeTree(dir);
      return this.syncAndCheckout(repo, rev);
    }
  }

  private async syncAndCheckout(repo: string, rev: string): Promise<string> {
    const dir = await this.syncMirror(repo);
    await this.deps.git(["checkout", "-f", rev], dir);
    await this.deps.git(["clean", "-fd", "-e", "node_modules"], dir);
    return dir;
  }

  /* A repo name that resolves to the mirrors root itself or above it is never something to delete. */
  private isDirectChildOfRoot(dir: string): boolean {
    const name = basename(dir);
    return name !== "" && name !== "." && name !== ".." && dirname(resolve(dir)) === resolve(this.deps.root);
  }

  /* Brings the mirror up to date with origin: tokenless clone when missing, fetch when present. On the existing-dir path it first self-heals two failure modes: a stale `.git/index.lock` (a prior abruptly-interrupted provisioning, from this or the onboarding path) and a token embedded in origin's URL (mirrors cloned before the tokenless-URL policy persist the credential in .git/config; `remote set-url` scrubs it on the next run). */
  private async syncMirror(repo: string): Promise<string> {
    const dir = this.mirrorDir(repo);
    if (!this.deps.exists(dir)) {
      await this.deps.git(["clone", this.deps.remoteUrl(repo), dir]);
    } else {
      /* The sandbox owns the mirror's directory and can swap `.git` for a link: verify it before deleting inside it. */
      assertTrustedGitTree(dir);
      const indexLock = join(dir, ".git", "index.lock");
      if (this.deps.exists(indexLock)) this.deps.removeFile(indexLock);
      await this.deps.git(["remote", "set-url", "origin", this.deps.remoteUrl(repo)], dir);
      await this.deps.git(["fetch", "--no-recurse-submodules", "origin"], dir);
    }
    return dir;
  }
}
