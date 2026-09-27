/* Local publication effector (slim deployment profile). Implements the collaborator surfaces PublicationPortAdapter dispatches to — git write (publish), PR (openWithAutoMerge), Issue (open) and the shadow preview (openPr/openIssue) — but writes to disk instead of an SCM host. The publish DECISION is untouched; only its effect moves: a would-be PR becomes files/**, changes.patch and MR.md under exportDir, a would-be Issue becomes ISSUE.md. A human submits them, so nothing writes to the watched repo automatically.
 *
 * Git use on the mirror is read-only (status/diff) plus a transient intent-to-add for untracked files that is always reset before returning, so the next run's mirror sync sees exactly the tree remote publication would leave. The adapter never reads env: exportDir, mirrorDir and the git runner are injected. */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ExportGit = (args: string[], cwd: string) => Promise<string>;

export interface LocalExportFs {
  mkdir(path: string): void;
  write(path: string, content: string): void;
  copy(src: string, dest: string): void;
  exists(path: string): boolean;
}

export const nodeLocalExportFs: LocalExportFs = {
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  write: (path, content) => writeFileSync(path, content, "utf8"),
  copy: (src, dest) => copyFileSync(src, dest),
  exists: existsSync,
};

export interface LocalExportDeps {
  /* Per-run folder: every artifact of this run lands here. */
  exportDir: string;
  /* Primary mirror. Used by the shadow preview, whose call carries no per-run mirrorDir. */
  mirrorDir: string;
  baseBranch: string;
  /* Commit message suggested in the apply steps (same wording remote publication commits with). */
  commitMessage?: string;
  /* Pathspecs eligible for export (e.g. ["e2e"], or the single context map file). */
  addPaths: readonly string[];
  /* gitignore-style patterns applied before the change scan (installed deps, coverage dumps). */
  excludes: readonly string[];
  git: ExportGit;
  writeExcludes(mirrorDir: string, patterns: readonly string[]): void;
  fs?: LocalExportFs;
  now?: () => Date;
  log?: (msg: string) => void;
}

interface ChangedFile {
  path: string;
  deleted: boolean;
  untracked: boolean;
}

interface ExportedChanges {
  files: string[];
  deleted: string[];
  sha?: string;
  branch: string;
}

/* `git status --porcelain -z`: entries are NUL-separated "XY path"; a rename/copy entry is followed by its source path as a separate token, which is skipped. */
export function parsePorcelainZ(out: string): ChangedFile[] {
  const tokens = out.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]!;
    if (entry.length < 4) continue;
    const x = entry[0]!;
    const y = entry[1]!;
    const path = entry.slice(3);
    if (x === "R" || x === "C") i++;
    files.push({ path, deleted: x === "D" || y === "D", untracked: x === "?" && y === "?" });
  }
  return files;
}

export class LocalExportPublicationAdapter {
  private readonly fs: LocalExportFs;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  private exported: ExportedChanges | undefined;

  constructor(private readonly deps: LocalExportDeps) {
    this.fs = deps.fs ?? nodeLocalExportFs;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? console.log;
  }

  /* Git-write facet ("pr" route): export the changes instead of commit + push. `changed: false` keeps the agent's no-op a no-op. */
  async publish(input: { mirrorDir: string; branch: string; sha: string }): Promise<{ changed: boolean }> {
    const exported = await this.exportChanges(input.mirrorDir, input.branch, input.sha);
    return { changed: exported.files.length + exported.deleted.length > 0 };
  }

  /* PR facet: the Merge Request a human opens from the exported patch. */
  async openWithAutoMerge(repo: string, branch: string, title: string, body: string): Promise<{ url: string; number: number }> {
    const path = this.writeRequest("MR.md", this.renderMergeRequest(repo, branch, title, body, false));
    this.log(`[export] merge request exported for ${repo} → ${path}`);
    return { url: path, number: 0 };
  }

  /* Issue facet. */
  async open(repo: string, title: string, body: string): Promise<{ url: string; number: number }> {
    const path = this.writeRequest("ISSUE.md", this.renderIssue(repo, title, body, false));
    this.log(`[export] issue exported for ${repo} → ${path}`);
    return { url: path, number: 0 };
  }

  /* Shadow facet: the same artifacts, flagged as a preview of what the decision would have published. */
  async openPr(repo: string, branch: string, title: string, body: string): Promise<void> {
    if (!this.exported) await this.exportChanges(this.deps.mirrorDir, branch);
    const path = this.writeRequest("MR.md", this.renderMergeRequest(repo, branch, title, body, true));
    this.log(`[export] shadow merge request exported for ${repo} → ${path}`);
  }

  async openIssue(repo: string, title: string, body: string): Promise<void> {
    const path = this.writeRequest("ISSUE.md", this.renderIssue(repo, title, body, true));
    this.log(`[export] shadow issue exported for ${repo} → ${path}`);
  }

  private async exportChanges(mirrorDir: string, branch: string, sha?: string): Promise<ExportedChanges> {
    this.deps.writeExcludes(mirrorDir, this.deps.excludes);
    const changed = parsePorcelainZ(
      await this.deps.git(["status", "--porcelain", "-z", "--untracked-files=all", "--", ...this.deps.addPaths], mirrorDir),
    );
    const exported: ExportedChanges = {
      files: changed.filter((f) => !f.deleted).map((f) => f.path),
      deleted: changed.filter((f) => f.deleted).map((f) => f.path),
      branch,
      ...(sha ? { sha } : {}),
    };
    this.exported = exported;
    if (changed.length === 0) return exported;

    const filesDir = join(this.deps.exportDir, "files");
    for (const file of exported.files) {
      const dest = join(filesDir, file);
      this.fs.mkdir(dirname(dest));
      this.fs.copy(join(mirrorDir, file), dest);
    }
    this.fs.mkdir(this.deps.exportDir);
    this.fs.write(join(this.deps.exportDir, "changes.patch"), await this.buildPatch(mirrorDir, changed));
    this.fs.write(
      join(this.deps.exportDir, "export.json"),
      JSON.stringify(
        { branch, baseBranch: this.deps.baseBranch, ...(sha ? { sha } : {}), files: exported.files, deleted: exported.deleted, exportedAt: this.now().toISOString() },
        null,
        2,
      ) + "\n",
    );
    return exported;
  }

  /* Diff against HEAD over exactly the changed paths. Untracked files enter the diff via intent-to-add, which is reset afterwards even when the diff throws. */
  private async buildPatch(mirrorDir: string, changed: readonly ChangedFile[]): Promise<string> {
    const untracked = changed.filter((f) => f.untracked).map((f) => f.path);
    if (untracked.length > 0) await this.deps.git(["add", "--intent-to-add", "--", ...untracked], mirrorDir);
    try {
      return await this.deps.git(["diff", "--binary", "HEAD", "--", ...changed.map((f) => f.path)], mirrorDir);
    } finally {
      if (untracked.length > 0) await this.deps.git(["reset", "-q", "--", ...untracked], mirrorDir);
    }
  }

  private writeRequest(fileName: string, content: string): string {
    this.fs.mkdir(this.deps.exportDir);
    const path = join(this.deps.exportDir, fileName);
    this.fs.write(path, content);
    return path;
  }

  private renderMergeRequest(repo: string, branch: string, title: string, body: string, shadow: boolean): string {
    const exported = this.exported;
    const files = exported?.files ?? [];
    const deleted = exported?.deleted ?? [];
    const lines = [
      `# ${title}`,
      "",
      shadow ? "> Shadow preview: the publish decision was computed, nothing was submitted.\n" : "",
      "| | |",
      "|---|---|",
      `| Repository | \`${repo}\` |`,
      `| Source branch (suggested) | \`${branch}\` |`,
      `| Target branch | \`${this.deps.baseBranch}\` |`,
      ...(exported?.sha ? [`| Commit under test | \`${exported.sha}\` |`] : []),
      `| Exported | ${this.now().toISOString()} |`,
      "",
      "## Files",
      "",
      ...files.map((f) => `- \`${f}\``),
      ...deleted.map((f) => `- \`${f}\` (deleted)`),
      ...(files.length + deleted.length === 0 ? ["- (no file changes)"] : []),
      "",
      "## Apply",
      "",
      "```bash",
      `git fetch origin && git checkout -b ${branch} origin/${this.deps.baseBranch}`,
      "git apply --index changes.patch",
      `git commit -m "${this.deps.commitMessage ?? "test(e2e): automated QA"}" && git push -u origin ${branch}`,
      "```",
      "",
      "## Merge request description",
      "",
      body,
      "",
    ];
    return lines.filter((l, i) => !(l === "" && lines[i - 1] === "")).join("\n");
  }

  private renderIssue(repo: string, title: string, body: string, shadow: boolean): string {
    return [
      `# ${title}`,
      "",
      ...(shadow ? ["> Shadow preview: the publish decision was computed, nothing was submitted.", ""] : []),
      `Repository: \`${repo}\` · Exported: ${this.now().toISOString()}`,
      "",
      body,
      "",
    ].join("\n");
  }
}
