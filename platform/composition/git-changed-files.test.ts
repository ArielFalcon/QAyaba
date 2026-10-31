/* gitChangedFiles runs real git on a mirror, and its commits come from places the orchestrator does not control: a stored context map's `builtAtSha` is written by an agent. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitChangedFiles } from "./run-engine-factory";
import { GIT_ENV, closeGitDir, git } from "../../engine/test/shared-infrastructure/process-sandbox/git-fixtures";

function withMirror(body: (repo: string, first: string, second: string, scratch: string) => void): void {
  const scratch = mkdtempSync(join(tmpdir(), "qayaba-changed-files-"));
  try {
    const repo = join(scratch, "mirror");
    execFileSync("git", ["init", "-q", repo], { env: GIT_ENV });
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-qm", "first");
    const first = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-qm", "second");
    const second = git(repo, "rev-parse", "HEAD");
    closeGitDir(repo);
    body(repo, first, second, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("the files that differ between two commits of the mirror are listed", () => {
  withMirror((repo, first, second) => {
    assert.deepEqual(gitChangedFiles(repo, first, second), [{ status: "A", path: "b.txt" }]);
    assert.deepEqual(gitChangedFiles(repo, first.slice(0, 9), second.slice(0, 9)), [{ status: "A", path: "b.txt" }]);
  });
});

test("a commit that is an option is never handed to git: nothing is written, nothing is compared", () => {
  withMirror((repo, first, second, scratch) => {
    const probe = join(scratch, "written-by-git");
    for (const [from, to] of [[`--output=${probe}`, second], [first, `--output=${probe}`], ["-x", second], ["main", second], ["", second]] as const) {
      assert.equal(gitChangedFiles(repo, from, to), undefined, `${from} ${to}`);
    }
    assert.equal(existsSync(probe), false, "git wrote the file the argument named");
  });
});
