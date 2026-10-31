import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_ENV, makeGitlinkRepo, plantNestedRepo, ranPlantedCommand, writeMarkerCommand } from "../engine/test/shared-infrastructure/process-sandbox/git-fixtures.ts";
import { getCommitDiff, getCommitMessage, listChangedSpecs, type BaselineGit } from "./baseline-agent-git.ts";

/* A git stub whose output depends on the args (so the parent-count probe and the diff can return different things). */
function gitStub(reply: (args: string[]) => string): BaselineGit & { calls: string[][] } {
  const calls: string[][] = [];
  return { calls, git: async (args) => { calls.push(args); return reply(args); } };
}

test("getCommitDiff of a single-parent commit uses plain git show", async () => {
  /* the stub's git returns "diff-output" for the %P probe → one token → single parent. */
  const d = gitStub(() => "diff-output");
  const diff = await getCommitDiff("/tmp/mirrors/org__app", "abc1234", d);
  assert.equal(diff, "diff-output");
  assert.deepEqual(d.calls[0], ["show", "-s", "--format=%P", "abc1234"]);
  assert.deepEqual(d.calls[1], ["show", "--format=", "abc1234"]); /* single parent → plain diff */
});

test("getCommitDiff with commits>1 diffs the last N commits ending at the SHA (sha~N..sha)", async () => {
  const d = gitStub(() => "multi-commit-diff");
  const diff = await getCommitDiff("/dir", "abc1234", d, 3);
  assert.equal(diff, "multi-commit-diff");
  /* a single `git diff sha~3 sha` — no per-commit %P probe, the whole window in one shot */
  assert.deepEqual(d.calls[0], ["diff", "abc1234~3", "abc1234"]);
  assert.equal(d.calls.length, 1);
});

test("getCommitDiff diffs a MERGE commit against its first parent (not an empty diff)", async () => {
  const d = gitStub((args) => (args.includes("--format=%P") ? "p1aaaa p2bbbb" : "real-merge-diff"));
  const diff = await getCommitDiff("/dir", "abc1234", d);
  assert.equal(diff, "real-merge-diff"); /* not "" — the merge's blast radius is visible */
  assert.deepEqual(d.calls[0], ["show", "-s", "--format=%P", "abc1234"]);
  assert.deepEqual(d.calls[1], ["show", "--format=", "-m", "--first-parent", "abc1234"]);
});

test("listChangedSpecs returns e2e-relative spec paths from git status, excluding the seed", async () => {
  const porcelain =
    [
      "?? e2e/flows/login.spec.ts",
      " M e2e/flows/checkout.spec.ts",
      "?? e2e/cleanup.spec.ts",
      "?? e2e/.qa/manifest.json", /* not a spec — excluded */
      "A  e2e/fixtures.ts", /* not a spec — excluded */
    ].join("\n") + "\n";
  const d = gitStub(() => porcelain);
  const specs = await listChangedSpecs("/dir", "e2e", d);
  assert.deepEqual(specs, ["flows/login.spec.ts", "flows/checkout.spec.ts"]);
});

test("listChangedSpecs follows a rename to the new path", async () => {
  const d = gitStub(() => "R  e2e/flows/old.spec.ts -> e2e/flows/new.spec.ts\n");
  assert.deepEqual(await listChangedSpecs("/dir", "e2e", d), ["flows/new.spec.ts"]);
});

test("listChangedSpecs passes --untracked-files=all so first-run specs in an untracked e2e/ are seen", async () => {
  /* FIRST run on a newly-onboarded app: the seed e2e/ is entirely untracked, so plain
     `git status --porcelain` collapses it to one `?? e2e/` line and hides the specs inside,
     which made the agent's real tests read as "0 on disk" → a false `skipped`. -uall recurses
     into the untracked directory and names each file. This test guards that flag.
   */
  const d = gitStub(() => "?? e2e/flows/login.spec.ts\n");
  const specs = await listChangedSpecs("/dir", "e2e", d);
  assert.deepEqual(specs, ["flows/login.spec.ts"]);
  assert.ok(d.calls[0]?.includes("--untracked-files=all"), "git status must pass --untracked-files=all");
});

test("listChangedSpecs never enters a submodule the sandbox populated inside the folder it scans", async () => {
  /* A committed gitlink's directory belongs to the sandbox, which can put a repository of its own there; root git that
     enters it runs the filter its config names. */
  const root = mkdtempSync(join(tmpdir(), "list-specs-gitlink-"));
  try {
    const { marker, command } = writeMarkerCommand(root);
    const fixture = makeGitlinkRepo(root);
    plantNestedRepo(fixture, command);
    writeFileSync(join(fixture.repo, "new.spec.ts"), "test('x', () => {});\n");
    const d: BaselineGit = {
      git: async (args, cwd) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }),
    };

    assert.deepEqual(await listChangedSpecs(fixture.repo, ".", d), ["new.spec.ts"]);
    assert.equal(ranPlantedCommand(marker), false, "the status ran the planted filter");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getCommitDiff propagates git show failure", async () => {
  const d: BaselineGit = {
    git: async () => { throw new Error("git show failed: bad object"); },
  };
  await assert.rejects(() => getCommitDiff("/dir", "abc1234", d), /git show failed/);
});

test("listChangedSpecs propagates git status failure", async () => {
  const d: BaselineGit = {
    git: async () => { throw new Error("git status failed: not a git repository"); },
  };
  await assert.rejects(() => listChangedSpecs("/dir", "e2e", d), /git status failed/);
});

test("getCommitMessage propagates git show failure", async () => {
  const d: BaselineGit = {
    git: async () => { throw new Error("git show failed"); },
  };
  await assert.rejects(() => getCommitMessage("/dir", "abc1234", d), /git show failed/);
});

test("getCommitDiff rejects a non-hex sha (git argument-injection defense) before spawning git", async () => {
  const d = gitStub(() => "");
  await assert.rejects(() => getCommitDiff("/dir", "not-a-sha", d), /invalid commit sha/);
  assert.equal(d.calls.length, 0); /* never reached git */
});
