/* Real-git fixtures shared by the tests of every root git call on a sandbox-touched working copy.
   Nothing here depends on the ambient umask: the git dir of each fixture is closed explicitly. */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, lstatSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.com",
};

/** Runs git in `cwd` and returns its trimmed stdout. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Removes write access for the group and everyone else on the whole git dir, whatever umask created it. */
export function closeGitDir(repo: string): void {
  const walk = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    chmodSync(path, stat.mode & ~0o022);
    if (stat.isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry));
  };
  walk(join(repo, ".git"));
}

/** A script that records that it ran, and passes its stdin through so it works as a clean filter. */
export function writeMarkerCommand(root: string): { marker: string; command: string } {
  const marker = join(root, "marker");
  const command = join(root, "planted-command.sh");
  writeFileSync(command, `#!/bin/sh\necho ran >> "${marker}"\ncat\n`, { mode: 0o755 });
  return { marker, command };
}

export const ranPlantedCommand = (marker: string): boolean => existsSync(marker) && readFileSync(marker, "utf8").includes("ran");

export interface GitlinkRepo {
  /** The watched repository: a committed gitlink `sub` whose directory exists and is empty, as after a clone that never checked submodules out. */
  repo: string;
  /** The repository whose HEAD the gitlink points at. */
  subSource: string;
  subSha: string;
}

/** A working copy with `a.txt` and `e2e/spec.ts` committed, plus a gitlink `sub` (mode 160000) at `subSource`'s HEAD. */
export function makeGitlinkRepo(root: string): GitlinkRepo {
  const subSource = join(root, "sub-source");
  mkdirSync(subSource);
  git(subSource, "init", "-q");
  writeFileSync(join(subSource, "f.txt"), "a\n");
  git(subSource, "add", "f.txt");
  git(subSource, "commit", "-qm", "sub");
  const subSha = git(subSource, "rev-parse", "HEAD");

  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "a\n");
  mkdirSync(join(repo, "e2e"));
  writeFileSync(join(repo, "e2e", "spec.ts"), "test('x', () => {});\n");
  git(repo, "add", "a.txt", "e2e/spec.ts");
  git(repo, "update-index", "--add", "--cacheinfo", `160000,${subSha},sub`);
  git(repo, "commit", "-qm", "with gitlink");
  mkdirSync(join(repo, "sub"));
  closeGitDir(repo);
  return { repo, subSource, subSha };
}

/**
 * A repository of its own inside a working copy, as a test that runs `git init` under the tree (or a git dependency
 * directory) leaves behind: one commit, and, with `command`, a clean filter that records that it ran plus a same-size
 * edit that makes git hash the file again.
 */
export function makeEmbeddedRepo(dir: string, command?: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, "f.txt"), "a\n");
  git(dir, "add", "f.txt");
  git(dir, "commit", "-qm", "embedded");
  if (command === undefined) return;
  git(dir, "config", "filter.planted.clean", command);
  writeFileSync(join(dir, ".gitattributes"), "* filter=planted\n");
  const edited = join(dir, "f.txt");
  writeFileSync(edited, "b\n");
  const later = new Date(Date.now() + 60_000);
  utimesSync(edited, later, later);
}

/** The paths the index records as submodule entries (mode 160000), as plain git reports them. */
export function indexedGitlinks(repo: string): string[] {
  return git(repo, "ls-files", "--stage")
    .split("\n")
    .filter((line) => line.startsWith("160000 "))
    .map((line) => line.slice(line.indexOf("\t") + 1));
}

/**
 * What the sandbox does with the empty directory of a committed gitlink: it puts a repository of its own there whose
 * config names `command` as a clean filter, applies the filter to every file, and edits a file to the same size so git
 * has to hash it again (which runs the filter). Any root git that enters the gitlink runs `command`.
 * With `movePointer` the nested repository's HEAD is also moved off the commit the gitlink records.
 */
export function plantNestedRepo(fixture: GitlinkRepo, command: string, options: { movePointer?: boolean } = {}): void {
  const nested = join(fixture.repo, "sub");
  execFileSync("git", ["clone", "-q", fixture.subSource, nested], { env: GIT_ENV, stdio: "ignore" });
  if (options.movePointer) git(nested, "commit", "--allow-empty", "-qm", "moved");
  git(nested, "config", "filter.planted.clean", command);
  writeFileSync(join(nested, ".gitattributes"), "* filter=planted\n");
  const edited = join(nested, "f.txt");
  writeFileSync(edited, "b\n");
  const later = new Date(Date.now() + 60_000);
  utimesSync(edited, later, later);
}
