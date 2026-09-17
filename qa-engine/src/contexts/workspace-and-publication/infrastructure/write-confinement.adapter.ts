/* Tracked strays revert via staged-aware `git restore --staged --worktree --source=HEAD` (a plain checkout would leave a staged-new stray). Untracked strays: `git clean -f`. A symlink whose realpath escapes mirrorDir is dangerous and reverted in both targets (code-mode stages `.`). Git errors throw here; RunQaUseCase fail-opens around enforce(). */
import { join, sep } from "node:path";
import { WriteConfinementService, type GitRename } from "../domain/write-confinement.service.ts";

export type Git = (args: string[], cwd?: string) => Promise<string>;

export interface WriteConfinementAdapterDeps {
  git: Git;
  realpath(p: string): string;
  isSymlink(p: string): boolean;
}

export interface ConfinementResult {
  strays: number;
  dangerous: number;
  reverted: string[];
}

export class WriteConfinementAdapter {
  private readonly classifier = new WriteConfinementService();

  constructor(private readonly deps: WriteConfinementAdapterDeps) {}

  async enforce(mirrorDir: string, isCode: boolean, signal?: AbortSignal): Promise<ConfinementResult> {
    if (signal?.aborted) {
      return { strays: 0, dangerous: 0, reverted: [] };
    }

    const out = await this.deps.git(["status", "--porcelain", "--untracked-files=all"], mirrorDir);
    const changes = this.classifier.parseStatusOutput(out);
    const { tracked, untracked, dangerousByPath } = this.classifier.classifyStrays(changes, isCode);

    const escapes: string[] = [];
    const mirrorReal = this.deps.realpath(mirrorDir) + sep;
    for (const { xy, path, renameCounterpart } of changes) {
      if (!isCode && path !== "e2e" && !path.startsWith("e2e/")) continue;
      let resolved: string;
      try {
        if (!this.deps.isSymlink(join(mirrorDir, path))) continue;
        resolved = this.deps.realpath(join(mirrorDir, path));
      } catch {
        continue;
      }
      if (resolved.startsWith(mirrorReal)) continue;
      escapes.push(path);
      for (const p of this.classifier.revertUnit(path, renameCounterpart)) {
        if (!tracked.includes(p) && !untracked.includes(p)) {
          if (xy === "??") untracked.push(p);
          else tracked.push(p);
        }
      }
    }

    const isConfined = (p: string): boolean => (isCode ? !this.classifier.isCodeDenied(p) : !this.classifier.isE2eStray(p));
    const candidateDeleted = changes
      .filter((c) => c.xy === " D" && c.renameCounterpart === undefined && isConfined(c.path))
      .map((c) => c.path);
    let restoredDeleted: string[] = [];
    if (candidateDeleted.length > 0 && untracked.length > 0) {
      let gitRenames: GitRename[] = [];
      try {
        await this.deps.git(["add", "-N", "--", ...untracked], mirrorDir);
        const diffOut = await this.deps.git(
          ["diff", "--find-renames", "-M50%", "--diff-filter=R", "--name-status", "HEAD"],
          mirrorDir,
        );
        gitRenames = parseRenameNameStatus(diffOut, (raw) => this.classifier.decodeGitPath(raw));
      } finally {
        await this.deps.git(["reset", "--", ...untracked], mirrorDir);
      }
      restoredDeleted = this.classifier.pairUnstagedRenames(candidateDeleted, untracked, gitRenames).restore;
    }

    if (tracked.length > 0) {
      await this.deps.git(["restore", "--staged", "--worktree", "--source=HEAD", "--", ...tracked], mirrorDir);
    }
    if (untracked.length > 0) {
      await this.deps.git(["clean", "-f", "--", ...untracked], mirrorDir);
    }
    if (restoredDeleted.length > 0) {
      await this.deps.git(["restore", "--source=HEAD", "--", ...restoredDeleted], mirrorDir);
    }

    return {
      strays: tracked.length + untracked.length + restoredDeleted.length,
      dangerous: new Set([...dangerousByPath, ...escapes]).size,
      reverted: [...tracked, ...untracked, ...restoredDeleted],
    };
  }
}

function parseRenameNameStatus(out: string, decode: (raw: string) => string): GitRename[] {
  return out
    .split("\n")
    .filter((l) => l.startsWith("R"))
    .map((l) => l.split("\t"))
    .filter((parts): parts is [string, string, string] => parts.length === 3)
    .map(([, from, to]) => ({ from: decode(from as string), to: decode(to as string) }));
}
