/* Tracked strays revert via staged-aware `git restore --staged --worktree --source=HEAD` (a plain checkout would leave a staged-new stray). Untracked strays: `git clean -f`. A symlink whose realpath escapes mirrorDir is dangerous and reverted in both targets (code-mode stages `.`). Git errors throw here; RunQaUseCase fail-opens around enforce(). */
import { dirname, isAbsolute, join, sep } from "node:path";
import { WriteConfinementService, type GitRename } from "../domain/write-confinement.service.ts";

export type Git = (args: string[], cwd?: string) => Promise<string>;

/* A submodule directory belongs to the sandbox, which can plant a repository in it whose config names a command. Reporting a submodule's dirty content makes git enter it and run that command as the orchestrator; a pointer moved off its recorded commit is still reported, without entering it. */
const IGNORE_SUBMODULE_CONTENT = "--ignore-submodules=dirty";

export interface WriteConfinementAdapterDeps {
  git: Git;
  realpath(p: string): string;
  isSymlink(p: string): boolean;
  /** Deletes a directory tree without following a link inside it. Unwired, a working copy holding an embedded repository fails the pass loudly. */
  removeDirectory?(path: string): void;
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

    const out = await this.deps.git(["status", "--porcelain", "--untracked-files=all", IGNORE_SUBMODULE_CONTENT], mirrorDir);
    const parsed = this.classifier.parseStatusOutput(out);
    /* With every untracked file listed, an untracked directory is a repository of its own: git never enters it. */
    const embedded = parsed.filter((c) => c.xy === "??" && c.path.endsWith("/")).map((c) => c.path);
    this.removeEmbeddedRepositories(mirrorDir, embedded);
    const changes = parsed.filter((c) => !embedded.includes(c.path));
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
          ["diff", "--find-renames", "-M50%", "--diff-filter=R", "--name-status", IGNORE_SUBMODULE_CONTENT, "HEAD"],
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
      strays: embedded.length + tracked.length + untracked.length + restoredDeleted.length,
      dangerous: new Set([...dangerousByPath, ...escapes]).size,
      reverted: [...embedded, ...tracked, ...untracked, ...restoredDeleted],
    };
  }

  /* A repository under the working copy is never legitimate test output, and staging it records a gitlink that leaves the working copy unusable, so it goes like any other stray. */
  private removeEmbeddedRepositories(mirrorDir: string, embedded: readonly string[]): void {
    if (embedded.length === 0) return;
    const remove = this.deps.removeDirectory;
    if (!remove) throw new Error(`the working copy holds an embedded repository (${embedded.join(", ")}) and nothing is wired to remove it`);
    const mirrorReal = this.deps.realpath(mirrorDir) + sep;
    for (const path of embedded) {
      const target = join(mirrorDir, path);
      /* git reports paths under the working copy; one that names anything else is never deleted. */
      if (isAbsolute(path) || path.split("/").includes("..") || !`${this.deps.realpath(dirname(target))}${sep}`.startsWith(mirrorReal)) {
        throw new Error(`refusing to remove the embedded repository ${JSON.stringify(path)}: it does not resolve inside the working copy`);
      }
      console.error(`[qa] write-confinement: removing the embedded repository ${JSON.stringify(path)} (a repository under the working copy would be staged as a gitlink)`);
      remove(target);
    }
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
