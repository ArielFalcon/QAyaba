import { join } from "node:path";

export type Git = (args: string[], cwd?: string) => Promise<string>;

export interface MirrorProvisionDeps {
  git: Git;
  exists(path: string): boolean;
  removeFile(path: string): void;
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
    const dir = await this.syncMirror(repo);
    await this.deps.git(["checkout", "-f", sha], dir);
    await this.deps.git(["clean", "-fd", "-e", "node_modules"], dir);
    return dir;
  }

  async ensureMirrorAtBranch(repo: string, branch: string): Promise<string> {
    assertBranchName(branch);
    const dir = await this.syncMirror(repo);
    await this.deps.git(["checkout", "-f", `origin/${branch}`], dir);
    await this.deps.git(["clean", "-fd", "-e", "node_modules"], dir);
    return dir;
  }

  /* Brings the mirror up to date with origin: tokenless clone when missing, fetch when present. On the existing-dir path it first self-heals two failure modes: a stale `.git/index.lock` (a prior abruptly-interrupted provisioning, from this or the onboarding path) and a token embedded in origin's URL (mirrors cloned before the tokenless-URL policy persist the credential in .git/config; `remote set-url` scrubs it on the next run). */
  private async syncMirror(repo: string): Promise<string> {
    const dir = join(this.deps.root, repo.replaceAll("/", "__"));
    if (!this.deps.exists(dir)) {
      await this.deps.git(["clone", this.deps.remoteUrl(repo), dir]);
    } else {
      const indexLock = join(dir, ".git", "index.lock");
      if (this.deps.exists(indexLock)) this.deps.removeFile(indexLock);
      await this.deps.git(["remote", "set-url", "origin", this.deps.remoteUrl(repo)], dir);
      await this.deps.git(["fetch", "origin"], dir);
    }
    return dir;
  }
}
