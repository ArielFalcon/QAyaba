/* Local publication effector (slim deployment profile). Implements the collaborator surfaces PublicationPortAdapter dispatches to — git write (publish), PR (openWithAutoMerge), Issue (open) and the shadow preview (openPr/openIssue) — but writes to disk instead of an SCM host. The publish DECISION is untouched; only its effect moves: a would-be PR becomes files/**, changes.patch and MR.md under exportDir, a would-be Issue becomes ISSUE.md. A human submits them, so nothing writes to the watched repo automatically.
 *
 * Git use on the mirror is read-only (status/diff) plus a transient intent-to-add for untracked files that is always reset before returning, so the next run's mirror sync sees exactly the tree remote publication would leave. What leaves the mirror is confined like remote publication: denylisted paths and anything that is not a regular file inside the mirror are skipped and named in export.json, never copied. The adapter never reads env: exportDir, mirrorDir and the git runner are injected. */
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { WriteConfinementService } from "../domain/write-confinement.service.ts";

/* A submodule directory belongs to the sandbox, which can plant a repository in it whose config names a command. Reporting a submodule's dirty content makes git enter it and run that command as the orchestrator, so every status and diff here refuses to look (same flag as VcsWriteAdapter.hasChanges). */
const IGNORE_SUBMODULE_CONTENT = "--ignore-submodules=dirty";

export type ExportGit = (args: string[], cwd: string) => Promise<string>;

export interface LocalExportFs {
  mkdir(path: string): void;
  write(path: string, content: string): void;
  copy(src: string, dest: string): void;
  exists(path: string): boolean;
  /* True only for a regular file reached without following a link at its last segment (a link to a file, a directory and a device are all false). */
  isRegularFile(path: string): boolean;
  realpath(path: string): string;
}

export const nodeLocalExportFs: LocalExportFs = {
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  write: (path, content) => writeFileSync(path, content, "utf8"),
  copy: (src, dest) => copyFileSync(src, dest),
  exists: existsSync,
  isRegularFile: (path) => {
    try {
      return lstatSync(path).isFile();
    } catch {
      return false;
    }
  },
  realpath: (path) => realpathSync(path),
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
  /* Changed paths left out of the export (denylisted, or not a regular file inside the mirror). Names only, never contents. */
  skipped: string[];
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
  private readonly confinement = new WriteConfinementService();
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
    const scanned = parsePorcelainZ(
      await this.deps.git(["status", "--porcelain", "-z", "--untracked-files=all", IGNORE_SUBMODULE_CONTENT, "--", ...this.deps.addPaths], mirrorDir),
    );
    const { exportable, skipped } = scanned.length === 0 ? { exportable: [], skipped: [] } : this.confine(mirrorDir, scanned);
    const exported: ExportedChanges = {
      files: exportable.filter((f) => !f.deleted).map((f) => f.path),
      deleted: exportable.filter((f) => f.deleted).map((f) => f.path),
      skipped,
      branch,
      ...(sha ? { sha } : {}),
    };
    this.exported = exported;
    if (scanned.length === 0) return exported;
    if (skipped.length > 0) this.log(`[export] left out of the export (denylisted or not a regular file inside the mirror): ${skipped.join(", ")}`);

    const filesDir = join(this.deps.exportDir, "files");
    for (const file of exported.files) {
      const dest = join(filesDir, file);
      this.fs.mkdir(dirname(dest));
      this.fs.copy(join(mirrorDir, file), dest);
    }
    this.fs.mkdir(this.deps.exportDir);
    /* An empty pathspec would diff the whole tree, so a patch is only built over paths that are exported. */
    if (exportable.length > 0) this.fs.write(join(this.deps.exportDir, "changes.patch"), await this.buildPatch(mirrorDir, exportable));
    this.fs.write(
      join(this.deps.exportDir, "export.json"),
      JSON.stringify(
        {
          branch,
          baseBranch: this.deps.baseBranch,
          ...(sha ? { sha } : {}),
          files: exported.files,
          deleted: exported.deleted,
          skipped: exported.skipped,
          exportedAt: this.now().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    return exported;
  }

  /* The sandbox writes the mirror, so what git reports is not trusted as exportable: a path the write-confinement denylist covers (CI files, Dockerfiles, env files) never leaves, and a surviving file must be a regular file whose resolved path stays inside the mirror — a planted link would otherwise copy whatever it points at. A deletion has no file to read and only needs the denylist. */
  private confine(mirrorDir: string, changed: readonly ChangedFile[]): { exportable: ChangedFile[]; skipped: string[] } {
    const mirrorReal = this.fs.realpath(mirrorDir) + sep;
    const exportable: ChangedFile[] = [];
    const skipped: string[] = [];
    for (const file of changed) {
      const exportableFile = !this.confinement.isCodeDenied(file.path) && (file.deleted || this.isConfinedRegularFile(mirrorDir, mirrorReal, file.path));
      if (exportableFile) exportable.push(file);
      else skipped.push(file.path);
    }
    return { exportable, skipped };
  }

  private isConfinedRegularFile(mirrorDir: string, mirrorReal: string, path: string): boolean {
    const full = join(mirrorDir, path);
    if (!this.fs.isRegularFile(full)) return false;
    try {
      return this.fs.realpath(full).startsWith(mirrorReal);
    } catch {
      return false;
    }
  }

  /* Diff against HEAD over exactly the changed paths. Untracked files enter the diff via intent-to-add, which is reset afterwards even when the diff throws. */
  private async buildPatch(mirrorDir: string, changed: readonly ChangedFile[]): Promise<string> {
    const untracked = changed.filter((f) => f.untracked).map((f) => f.path);
    if (untracked.length > 0) await this.deps.git(["add", "--intent-to-add", "--", ...untracked], mirrorDir);
    try {
      return await this.deps.git(["diff", "--binary", IGNORE_SUBMODULE_CONTENT, "HEAD", "--", ...changed.map((f) => f.path)], mirrorDir);
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
