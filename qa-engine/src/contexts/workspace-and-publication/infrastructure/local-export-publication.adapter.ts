/* Local publication effector (slim deployment profile). Implements the collaborator surfaces PublicationPortAdapter dispatches to — git write (publish), PR (openWithAutoMerge), Issue (open) and the shadow preview (openPr/openIssue) — but writes to disk instead of an SCM host. The publish DECISION is untouched; only its effect moves: a would-be PR becomes files/**, changes.patch and MR.md under exportDir, a would-be Issue becomes ISSUE.md. A human submits them, so nothing writes to the watched repo automatically.
 *
 * Git use on the mirror is read-only (status/diff) plus a transient intent-to-add for untracked files that is always reset before returning, so the next run's mirror sync sees exactly the tree remote publication would leave. What leaves the mirror is confined like remote publication: denylisted paths and anything that is not a regular file inside the mirror are left out and named (with the reason) in export.json and MR.md, never copied. Every exported file and the patch are also screened for secrets through an injected check; a hit leaves the file out. The screen never trusts what git chooses to show: its diff forces textual hunks regardless of attributes, and a file git still hides is screened from the file itself. The adapter never reads env: exportDir, mirrorDir, the git runner and the secret check are injected. */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { WriteConfinementService } from "../domain/write-confinement.service.ts";

/* A submodule directory belongs to the sandbox, which can plant a repository in it whose config names a command. Reporting a submodule's dirty content makes git enter it and run that command as the orchestrator, so every status and diff here refuses to look (same flag as VcsWriteAdapter.hasChanges). */
const IGNORE_SUBMODULE_CONTENT = "--ignore-submodules=dirty";

/* What git shows of a file is decided by attributes the sandbox can write (an in-tree .gitattributes of any depth, .git/info/attributes) and by diff drivers: `-diff` or a binary driver turns a text change into "Binary files differ" or a base85 body. The diff that feeds the secret screen therefore forces textual hunks, with no external diff program and no text conversion. */
const SCREEN_DIFF_FLAGS = ["--text", "--no-ext-diff", "--no-textconv"];
/* The patch that is exported keeps binary files applicable. */
const EXPORT_DIFF_FLAGS = ["--binary", "--no-ext-diff", "--no-textconv"];

export type ExportGit = (args: string[], cwd: string) => Promise<string>;

export interface LocalExportFs {
  mkdir(path: string): void;
  write(path: string, content: string): void;
  copy(src: string, dest: string): void;
  exists(path: string): boolean;
  /* True only for a regular file reached without following a link at its last segment (a link to a file, a directory and a device are all false). */
  isRegularFile(path: string): boolean;
  realpath(path: string): string;
  read(path: string): string;
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
  read: (path) => readFileSync(path, "utf8"),
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
  /* True when the text carries a secret. Applied to every new file and to the lines the patch adds; a hit leaves that file out of the export. Required: there is no safe default. */
  containsSecret(text: string): boolean;
  writeExcludes(mirrorDir: string, patterns: readonly string[]): void;
  fs?: LocalExportFs;
  now?: () => Date;
  log?: (msg: string) => void;
}

interface ChangedFile {
  path: string;
  deleted: boolean;
  untracked: boolean;
  /* HEAD holds this path and the change is a plain edit of it (status M or unchanged on each side). Anything else that survives — untracked, staged new, intent-to-add, renamed, copied, type-changed — brings the whole file as new content. */
  modifiedInPlace: boolean;
}

/* A changed path that did not leave the mirror. Names and a reason only, never contents. */
export interface LeftOut {
  path: string;
  reason: string;
}

const REASON_DENYLISTED = "denylisted path";
const REASON_NOT_REGULAR = "not a regular file inside the mirror";
const REASON_SECRET = "contains a secret";
const REASON_UNREADABLE = "unreadable";
const REASON_ATTRIBUTES = "attributes file";

interface ExportedChanges {
  files: string[];
  deleted: string[];
  leftOut: LeftOut[];
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
    files.push({
      path,
      deleted: x === "D" || y === "D",
      untracked: x === "?" && y === "?",
      modifiedInPlace: (x === " " || x === "M") && (y === " " || y === "M"),
    });
  }
  return files;
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const BINARY_FILES_DIFFER = /^Binary files .* differ$/;

/* What a patch shows of the content it adds. `added` is the text of the added lines; `hidden` is true when a file section carries no hunks because git printed it as binary (a "GIT binary patch" body or a "Binary files differ" line), so its content is NOT in `added` and has to be read from the file. */
export interface PatchScan {
  added: string;
  hidden: boolean;
}

/* The lines a patch adds, without their `+` and joined by newlines: all the lines of a new file, only the new ones of a changed file. Context and removed lines are not part of what a change publishes, and a binary patch body (base85 of the file) is not text. A hunk is read by the line counts of its `@@` header, so an added line that looks like a file or hunk header is still an added line. A hunk that does not follow its counts makes the whole patch the answer: when unsure, everything is screened. */
export function scanPatch(patch: string): PatchScan {
  const lines = patch.split("\n");
  const added: string[] = [];
  let hidden = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++]!;
    const header = HUNK_HEADER.exec(line);
    if (!header) {
      if (line === "GIT binary patch" || BINARY_FILES_DIFFER.test(line)) hidden = true;
      continue;
    }
    let oldLeft = header[1] === undefined ? 1 : Number(header[1]);
    let newLeft = header[2] === undefined ? 1 : Number(header[2]);
    while (oldLeft > 0 || newLeft > 0) {
      const body = lines[i++];
      if (body === undefined) return { added: patch, hidden };
      if (body.startsWith("+")) {
        added.push(body.slice(1));
        newLeft--;
      } else if (body.startsWith("-")) {
        oldLeft--;
      } else if (body.startsWith(" ") || body === "") {
        oldLeft--;
        newLeft--;
      } else if (!body.startsWith("\\")) {
        return { added: patch, hidden };
      }
    }
  }
  return { added: added.join("\n"), hidden };
}

/* A git attributes file at any depth, matched the way a case-insensitive host treats the name. */
function isAttributesFile(path: string): boolean {
  return path.split("/").pop()?.toLowerCase() === ".gitattributes";
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
    if (typeof deps.containsSecret !== "function") {
      throw new Error("LocalExportPublicationAdapter: 'containsSecret' is a REQUIRED dependency — the composition root must inject the secret screen; refusing to export unscreened files.");
    }
  }

  /* Git-write facet ("pr" route): export the changes instead of commit + push. `changed: false` with no `leftOut` is the agent's no-op; `leftOut` names every changed path that stayed behind, so an export that is empty or partial for that reason never reads as "nothing to publish". */
  async publish(input: { mirrorDir: string; branch: string; sha: string }): Promise<{ changed: boolean; leftOut?: LeftOut[] }> {
    const exported = await this.exportChanges(input.mirrorDir, input.branch, input.sha);
    return {
      changed: exported.files.length + exported.deleted.length > 0,
      ...(exported.leftOut.length > 0 ? { leftOut: exported.leftOut } : {}),
    };
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
    const confined = scanned.length === 0 ? { exportable: [], leftOut: [] } : this.confine(mirrorDir, scanned);
    const screened = this.screenContents(mirrorDir, confined.exportable);
    const leftOut: LeftOut[] = [...confined.leftOut, ...screened.leftOut];
    const empty: ExportedChanges = { files: [], deleted: [], leftOut, branch, ...(sha ? { sha } : {}) };
    if (scanned.length === 0) {
      this.exported = empty;
      return empty;
    }
    /* An empty pathspec would diff the whole tree, so a patch is only built over paths that are exported. */
    const built = screened.exportable.length > 0 ? await this.buildScreenedPatch(mirrorDir, screened.exportable) : { patch: "", exportable: [], leftOut: [] };
    leftOut.push(...built.leftOut);
    const exported: ExportedChanges = {
      ...empty,
      files: built.exportable.filter((f) => !f.deleted).map((f) => f.path),
      deleted: built.exportable.filter((f) => f.deleted).map((f) => f.path),
    };
    this.exported = exported;
    if (leftOut.length > 0) this.log(`[export] left out of the export: ${leftOut.map((l) => `${l.path} (${l.reason})`).join(", ")}`);

    const filesDir = join(this.deps.exportDir, "files");
    for (const file of exported.files) {
      const dest = join(filesDir, file);
      this.fs.mkdir(dirname(dest));
      this.fs.copy(join(mirrorDir, file), dest);
    }
    this.fs.mkdir(this.deps.exportDir);
    if (built.exportable.length > 0) this.fs.write(join(this.deps.exportDir, "changes.patch"), built.patch);
    this.fs.write(
      join(this.deps.exportDir, "export.json"),
      JSON.stringify(
        {
          branch,
          baseBranch: this.deps.baseBranch,
          ...(sha ? { sha } : {}),
          files: exported.files,
          deleted: exported.deleted,
          skipped: leftOut.map((l) => l.path),
          leftOut,
          exportedAt: this.now().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    return exported;
  }

  /* The sandbox writes the mirror, so what git reports is not trusted as exportable: a path the write-confinement denylist covers (CI files, Dockerfiles, env files) never leaves, an attributes file of any depth never leaves (the published suite has no use for one, and it changes what git shows of every file it governs), and a surviving file must be a regular file whose resolved path stays inside the mirror — a planted link would otherwise copy whatever it points at. A deletion has no file to read and only needs the path checks. */
  private confine(mirrorDir: string, changed: readonly ChangedFile[]): { exportable: ChangedFile[]; leftOut: LeftOut[] } {
    const mirrorReal = this.fs.realpath(mirrorDir) + sep;
    const exportable: ChangedFile[] = [];
    const leftOut: LeftOut[] = [];
    for (const file of changed) {
      if (this.confinement.isCodeDenied(file.path)) leftOut.push({ path: file.path, reason: REASON_DENYLISTED });
      else if (isAttributesFile(file.path)) leftOut.push({ path: file.path, reason: REASON_ATTRIBUTES });
      else if (!file.deleted && !this.isConfinedRegularFile(mirrorDir, mirrorReal, file.path)) leftOut.push({ path: file.path, reason: REASON_NOT_REGULAR });
      else exportable.push(file);
    }
    return { exportable, leftOut };
  }

  /* A file the injected screen reads as carrying a secret stays in the mirror: the agent runs with the orchestrator's environment in reach, so a hardcoded credential must not travel to a human as an apply-ready patch. A file that brings its whole content as new (untracked, staged new, intent-to-add, renamed) is read whole, because all of its lines are new; a plain modification of a tracked file is screened through the lines its patch adds, so a literal that was already in the repository never holds an unrelated change back. A deletion adds nothing. */
  private screenContents(mirrorDir: string, changed: readonly ChangedFile[]): { exportable: ChangedFile[]; leftOut: LeftOut[] } {
    const exportable: ChangedFile[] = [];
    const leftOut: LeftOut[] = [];
    for (const file of changed) {
      if (file.deleted || file.modifiedInPlace) {
        exportable.push(file);
        continue;
      }
      const reason = this.screenRawContent(mirrorDir, file.path);
      if (reason) leftOut.push({ path: file.path, reason });
      else exportable.push(file);
    }
    return { exportable, leftOut };
  }

  /* Why the file as it sits in the mirror must stay out of the export, or undefined when it is clean. */
  private screenRawContent(mirrorDir: string, path: string): string | undefined {
    let content: string;
    try {
      content = this.fs.read(join(mirrorDir, path));
    } catch {
      return REASON_UNREADABLE;
    }
    return this.deps.containsSecret(content) ? REASON_SECRET : undefined;
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

  /* Diff against HEAD over exactly the changed paths, screened for secrets through the lines the diff adds. The screen reads a diff that forces textual hunks, so no attribute or diff driver can hide a file's lines; the exported patch is a separate diff that keeps binary files applicable. A file whose section is still hidden (git printed it as binary anyway) is screened from the file itself. Untracked files enter the diff via intent-to-add, which is reset afterwards even when a diff throws. A hit on the whole patch, or a hidden section, is narrowed file by file: those whose own diff carries a secret leave the export and the patch is rebuilt without them. A hit no single file explains is a secret spanning files, so nothing is exported. */
  private async buildScreenedPatch(mirrorDir: string, changed: readonly ChangedFile[]): Promise<{ patch: string; exportable: ChangedFile[]; leftOut: LeftOut[] }> {
    const untracked = changed.filter((f) => f.untracked).map((f) => f.path);
    if (untracked.length > 0) await this.deps.git(["add", "--intent-to-add", "--", ...untracked], mirrorDir);
    try {
      const diffOf = (flags: readonly string[], files: readonly ChangedFile[]): Promise<string> =>
        this.deps.git(["diff", ...flags, IGNORE_SUBMODULE_CONTENT, "HEAD", "--", ...files.map((f) => f.path)], mirrorDir);
      const whole = scanPatch(await diffOf(SCREEN_DIFF_FLAGS, changed));
      const hit = this.deps.containsSecret(whole.added);
      if (!hit && !whole.hidden) return { patch: await diffOf(EXPORT_DIFF_FLAGS, changed), exportable: [...changed], leftOut: [] };
      const exportable: ChangedFile[] = [];
      const leftOut: LeftOut[] = [];
      for (const file of changed) {
        const scan = scanPatch(await diffOf(SCREEN_DIFF_FLAGS, [file]));
        const reason = this.deps.containsSecret(scan.added) ? REASON_SECRET : scan.hidden && !file.deleted ? this.screenRawContent(mirrorDir, file.path) : undefined;
        if (reason) leftOut.push({ path: file.path, reason });
        else exportable.push(file);
      }
      if (hit && leftOut.length === 0) return { patch: "", exportable: [], leftOut: changed.map((f) => ({ path: f.path, reason: REASON_SECRET })) };
      return { patch: exportable.length > 0 ? await diffOf(EXPORT_DIFF_FLAGS, exportable) : "", exportable, leftOut };
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
    const leftOut = exported?.leftOut ?? [];
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
      ...(leftOut.length > 0
        ? [
            "## Left out",
            "",
            "These changed paths stayed in the mirror and are NOT part of this export (names and reasons only):",
            "",
            ...leftOut.map((l) => `- \`${l.path}\` — ${l.reason}`),
            "",
          ]
        : []),
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
