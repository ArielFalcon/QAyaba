import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitMirrorReadAdapter, MAX_FILE_AT_CHARS } from "@contexts/change-analysis/infrastructure/git-mirror-read.adapter.ts";
import type { SandboxedBinaryRunner, SandboxedRunRequest } from "../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { Sha } from "@kernel/sha.ts";
import { closeGitDir } from "../../../shared-infrastructure/process-sandbox/git-fixtures.ts";

function runnerReturning(stdout: string, capture?: (r: SandboxedRunRequest) => void): SandboxedBinaryRunner {
  return { run: async (req) => { capture?.(req); return { exitCode: 0, stdout, stderr: "", timedOut: false }; } };
}

/* A REAL SandboxedBinaryRunner that shells out to git for real — used only by the merge-commit
   integration test below, where a stub would beg the exact question under test (does the git range
   traverse both merge parents?). Deterministic: git output for a fixed repo is fixed.
 */
const realGitRunner: SandboxedBinaryRunner = {
  run: async (req) => {
    try {
      const stdout = execFileSync(req.command, [...req.args], { cwd: req.cwd, encoding: "utf8", env: { ...req.env, PATH: process.env.PATH ?? "" } });
      return { exitCode: 0, stdout, stderr: "", timedOut: false };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { exitCode: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(e), timedOut: false };
    }
  },
};

test("diff() shells git with the sha and returns stdout", async () => {
  let seen: SandboxedRunRequest | null = null;
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning("DIFF", (r) => (seen = r)));
  const out = await adapter.diff(Sha.of("abc1234"));
  assert.equal(out, "DIFF");
  assert.equal(seen!.command, "git");
  assert.ok(seen!.args.includes("abc1234"));
  assert.equal(seen!.cwd, "/repo");
});

test("blastRadius() returns a Sha-keyed BlastRadius from the parsed diff", async () => {
  const diff = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,1 +1,2 @@", " a", "+b"].join("\n");
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning(diff));
  const br = await adapter.blastRadius(Sha.of("abc1234"));
  assert.deepEqual([...br.changedFiles], ["x.ts"]);
  assert.equal(br.isEmpty, false);
});

test("message() returns the commit message stdout trimmed", async () => {
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning("feat: x\n\nbody\n"));
  assert.equal(await adapter.message(Sha.of("abc1234")), "feat: x\n\nbody");
});

test("diff() throws on non-zero exitCode — never returns silent empty diff", async () => {
  const badRunner: SandboxedBinaryRunner = {
    run: async () => ({ exitCode: 128, stdout: "", stderr: "fatal: bad object deadbeef", timedOut: false }),
  };
  const adapter = new GitMirrorReadAdapter("/repo", badRunner);
  await assert.rejects(
    () => adapter.diff(Sha.of("deadbeef")),
    (err: unknown) => err instanceof Error && /fatal: bad object deadbeef/.test(err.message),
    "expected diff() to throw when git exits non-zero",
  );
});

test("diff({baseSha}) shells git diff over the explicit baseSha..sha range, not the default sha^", async () => {
  let seen: SandboxedRunRequest | null = null;
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning("RANGE DIFF", (r) => (seen = r)));
  const out = await adapter.diff(Sha.of("deadbee1"), { baseSha: Sha.of("bad00001") });
  assert.equal(out, "RANGE DIFF");
  assert.ok(seen!.args.includes("bad00001"), "must pass baseSha as the range's lower bound");
  assert.ok(seen!.args.includes("deadbee1"));
  assert.ok(!seen!.args.some((a) => a === "deadbee1^"), "must NOT fall back to the single-commit sha^ form when baseSha is supplied");
});

test("otherMessages() shells git log over the FULL baseSha..sha range (NOT sha^), parses <hash>%x00<message>%x00 records, drops the head, splits NUL-delimited messages", async () => {
  let seen: SandboxedRunRequest | null = null;
  /* Record shape now: `<hash>\0<message>\0` per commit. The head (deadbee1...) must be dropped by
     hash; the other two messages survive. Hashes are full 40-char; the head arg is abbreviated
     (deadbee1) — the adapter must drop by PREFIX, not exact match.
   */
  const headFull = "deadbee1" + "0".repeat(32);
  const stdout = `${headFull}\0chore: merge feature\n\0abc1230000000000000000000000000000000000\0feat: add x\n\nbody line\0`;
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning(stdout, (r) => (seen = r)));
  const messages = await adapter.otherMessages(Sha.of("deadbee1"), { baseSha: Sha.of("bad00001") });
  assert.deepEqual(messages, ["feat: add x\n\nbody line"], "the head commit's own message is dropped; the merged-branch commit survives");
  assert.equal(seen!.command, "git");
  assert.ok(seen!.args.includes("bad00001..deadbee1"), "the range must be the FULL baseSha..sha (traverses BOTH merge parents), never baseSha..sha^ (first-parent only)");
  assert.ok(!seen!.args.some((a) => a.endsWith("^")), "must NOT use the first-parent-only sha^ form — that silently drops merged-branch commits");
});

test("otherMessages() returns [] when baseSha equals sha (degenerate/empty range) — no git call needed", async () => {
  let called = false;
  const adapter = new GitMirrorReadAdapter("/repo", { run: async () => { called = true; return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; } });
  const messages = await adapter.otherMessages(Sha.of("aaaaaaa1"), { baseSha: Sha.of("aaaaaaa1") });
  assert.deepEqual(messages, []);
  assert.equal(called, false, "a degenerate range must short-circuit without spawning git");
});

test("otherMessages() throws on non-zero exitCode — never returns a silent empty range", async () => {
  const badRunner: SandboxedBinaryRunner = {
    run: async () => ({ exitCode: 128, stdout: "", stderr: "fatal: bad revision", timedOut: false }),
  };
  const adapter = new GitMirrorReadAdapter("/repo", badRunner);
  await assert.rejects(
    () => adapter.otherMessages(Sha.of("deadbee1"), { baseSha: Sha.of("bad00001") }),
    (err: unknown) => err instanceof Error && /fatal: bad revision/.test(err.message),
  );
});

/* otherMessages() must reach a `feat:` commit on the merged branch (second parent). A first-parent
   range `baseSha..sha^` would drop that commit; the merge head itself must not appear.
 */
test("REAL merge commit: otherMessages() reaches the merged-branch commit (second-parent ancestry), and drops the merge head itself", async () => {
  const repo = mkdtempSync(join(tmpdir(), "qa-mergetest-"));
  try {
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" } }).trim();

    git("init", "-q");

    closeGitDir(repo);
    git("config", "user.email", "t@t.com");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "base.txt"), "base\n");
    git("add", "base.txt");
    git("commit", "-qm", "chore: base");
    const baseSha = git("rev-parse", "HEAD");
    /* Capture the default branch name NOW (varies by git version: master vs main) so we can return
       to it after the feature branch is done.
     */
    const defaultBranch = git("rev-parse", "--abbrev-ref", "HEAD");

    git("checkout", "-qb", "feature");
    writeFileSync(join(repo, "feature.txt"), "x\n");
    git("add", "feature.txt");
    git("commit", "-qm", "feat: add g in the merged branch");

    /* Return to the default branch and merge with --no-ff so a real merge commit (two parents) is
       created — the head commit's first parent is baseSha, its second parent is the feature commit.
     */
    git("checkout", "-q", defaultBranch);
    git("merge", "-q", "--no-ff", "feature", "-m", "chore: merge feature");
    const mergeSha = git("rev-parse", "HEAD");

    const adapter = new GitMirrorReadAdapter(repo, realGitRunner);
    const messages = await adapter.otherMessages(Sha.of(mergeSha), { baseSha: Sha.of(baseSha) });

    assert.ok(
      messages.some((m) => m.startsWith("feat: add g in the merged branch")),
      `the merged-branch feat commit must reach otherMessages() via second-parent ancestry — got: ${JSON.stringify(messages)}`,
    );
    assert.ok(
      !messages.some((m) => m.startsWith("chore: merge feature")),
      "the merge head's own message must be dropped (it comes via message(sha), not otherMessages())",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/* A run hands the working tree to the unprivileged sandbox user. The next run of the same
   repo reads the diff as the orchestrator: git then judges the tree to belong to someone else
   ("dubious ownership") and refuses to read it unless the caller opts out. GIT_TEST_ASSUME_DIFFERENT_OWNER
   makes git apply that same check to a tree this test's own user created. */
const differentOwnerGitRunner: SandboxedBinaryRunner = {
  run: (req) => realGitRunner.run({ ...req, env: { ...req.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" } }),
};

function twoCommitRepo(): { repo: string; baseSha: string; headSha: string } {
  const repo = mkdtempSync(join(tmpdir(), "qa-ownership-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" } }).trim();
  git("init", "-q");
  closeGitDir(repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-qm", "chore: first");
  const baseSha = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "b.txt"), "two\n");
  git("add", "b.txt");
  git("commit", "-qm", "feat: second");
  return { repo, baseSha, headSha: git("rev-parse", "HEAD") };
}

test("a working tree git considers owned by another user still yields its diff, message and range messages", async () => {
  const { repo, baseSha, headSha } = twoCommitRepo();
  try {
    const adapter = new GitMirrorReadAdapter(repo, differentOwnerGitRunner);
    assert.match(await adapter.diff(Sha.of(headSha)), /b\.txt/, "the diff of the head commit against its parent");
    assert.equal(await adapter.message(Sha.of(headSha)), "feat: second");
    const others = await adapter.otherMessages(Sha.of(headSha), { baseSha: Sha.of(baseSha) });
    assert.deepEqual(others, [], "the head's own message is not an 'other' message, and the range is readable");
    assert.match(await adapter.diff(Sha.of(headSha), { baseSha: Sha.of(baseSha) }), /b\.txt/, "the range diff against an explicit base");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/* The sandbox owns the working copy and can swap the root-owned `.git` for one of its own. Its config would plant
   a command (here diff.external) that git runs as the orchestrator while reading the diff. */
test("a swapped git dir is refused by every read and its planted diff command never runs", async () => {
  const { repo, baseSha, headSha } = twoCommitRepo();
  const scratch = mkdtempSync(join(tmpdir(), "qa-swapped-git-"));
  const marker = join(scratch, "marker");
  try {
    const planted = join(scratch, "planted-git");
    cpSync(join(repo, ".git"), planted, { recursive: true });
    const evil = join(scratch, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\necho ran >> "${marker}"\nexit 0\n`, { mode: 0o755 });
    execFileSync("git", ["config", "--file", join(planted, "config"), "diff.external", evil]);
    rmSync(join(repo, ".git"), { recursive: true });
    symlinkSync(planted, join(repo, ".git"));

    const adapter = new GitMirrorReadAdapter(repo, realGitRunner);
    await assert.rejects(() => adapter.diff(Sha.of(headSha)), /git dir|\.git/i);
    await assert.rejects(() => adapter.message(Sha.of(headSha)), /git dir|\.git/i);
    await assert.rejects(() => adapter.otherMessages(Sha.of(headSha), { baseSha: Sha.of(baseSha) }), /git dir|\.git/i);
    assert.equal(existsSync(marker) && readFileSync(marker, "utf8").includes("ran"), false, "git never ran against the swapped git dir");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("REAL repo: blastRadius() names a changed file whose path holds spaces and accents as it is on disk", async () => {
  const repo = mkdtempSync(join(tmpdir(), "qa-quotepath-"));
  try {
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, LC_ALL: "C", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" } }).trim();
    git("init", "-q");
    closeGitDir(repo);
    writeFileSync(join(repo, "base.txt"), "base\n");
    git("add", "base.txt");
    git("commit", "-qm", "chore: base");
    mkdirSync(join(repo, "src", "café dir"), { recursive: true });
    writeFileSync(join(repo, "src", "café dir", "página uno.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "plain.ts"), "export const b = 1;\n");
    git("add", ".");
    git("commit", "-qm", "feat: add files");

    const br = await new GitMirrorReadAdapter(repo, realGitRunner).blastRadius(Sha.of(git("rev-parse", "HEAD")));

    assert.deepEqual([...br.changedFiles].sort(), ["plain.ts", "src/café dir/página uno.ts"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ancestor() names the commit n steps behind sha through rev-parse", async () => {
  let seen: SandboxedRunRequest | null = null;
  const adapter = new GitMirrorReadAdapter("/repo", runnerReturning("b45e0001" + "0".repeat(32) + "\n", (r) => (seen = r)));
  const base = await adapter.ancestor(Sha.of("deadbee1"), 3);
  assert.equal(base.value, "b45e0001" + "0".repeat(32));
  assert.ok(seen!.args.includes("deadbee1~3^{commit}"));
});

test("ancestor() throws when git cannot name the commit", async () => {
  const adapter = new GitMirrorReadAdapter("/repo", { run: async () => ({ stdout: "", stderr: "bad revision", exitCode: 128, timedOut: false }) } as unknown as SandboxedBinaryRunner);
  await assert.rejects(() => adapter.ancestor(Sha.of("deadbee1"), 30), /rev-parse failed/);
});

test("REAL repo: fileAt() reads a file as it was at a commit, and answers undefined for a missing file or a ref outside its grammar", async () => {
  const repo = mkdtempSync(join(tmpdir(), "qa-fileat-"));
  try {
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, LC_ALL: "C", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" } }).trim();
    git("init", "-q");
    closeGitDir(repo);
    writeFileSync(join(repo, "api.yaml"), "v: 1\n");
    git("add", ".");
    git("commit", "-qm", "chore: one");
    writeFileSync(join(repo, "api.yaml"), "v: 2\n");
    git("commit", "-qam", "chore: two");
    const head = git("rev-parse", "HEAD");
    const adapter = new GitMirrorReadAdapter(repo, realGitRunner);

    assert.equal(await adapter.fileAt(head, "api.yaml"), "v: 2\n");
    assert.equal(await adapter.fileAt(`${head}^`, "api.yaml"), "v: 1\n");
    assert.equal(await adapter.fileAt(`${head}~1`, "api.yaml"), "v: 1\n");
    assert.equal(await adapter.fileAt(head, "missing.yaml"), undefined);
    assert.equal(await adapter.fileAt("--output=/tmp/x", "api.yaml"), undefined);
    assert.equal(await adapter.fileAt("HEAD", "api.yaml"), undefined);
    assert.equal(await adapter.fileAt(head, "-p"), undefined);
    assert.equal(await adapter.fileAt(head, "../api.yaml"), undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("fileAt() answers undefined for a timed-out read and for a file larger than a contract file can be", async () => {
  const timedOut = new GitMirrorReadAdapter("/repo", { run: async () => ({ stdout: "x", stderr: "", exitCode: null, timedOut: true }) } as unknown as SandboxedBinaryRunner);
  assert.equal(await timedOut.fileAt("deadbee1", "api.yaml"), undefined);
  const huge = new GitMirrorReadAdapter("/repo", runnerReturning("x".repeat(MAX_FILE_AT_CHARS + 1)));
  assert.equal(await huge.fileAt("deadbee1", "api.yaml"), undefined);
});

test("REAL repo: relation() tells a served commit that is behind, ahead, the same, diverged or unknown against the run's sha", async () => {
  const repo = mkdtempSync(join(tmpdir(), "qa-relation-"));
  try {
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, LC_ALL: "C", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" } }).trim();
    const commit = (file: string): string => {
      writeFileSync(join(repo, file), `${file}\n`);
      git("add", file);
      git("commit", "-qm", `feat: ${file}`);
      return git("rev-parse", "HEAD");
    };
    git("init", "-q", "-b", "main");
    closeGitDir(repo);
    const root = commit("root.txt");
    const middle = commit("middle.txt");
    const tip = commit("tip.txt");
    git("checkout", "-q", "-b", "side", root);
    const side = commit("side.txt");
    const adapter = new GitMirrorReadAdapter(repo, realGitRunner);

    assert.equal(await adapter.relation(root, Sha.of(tip)), "served-is-ancestor", "DEV serves an older commit: the deploy has not landed");
    assert.equal(await adapter.relation(tip, Sha.of(middle)), "head-is-ancestor", "DEV serves a newer commit than the one under test");
    assert.equal(await adapter.relation(middle.slice(0, 8), Sha.of(middle)), "same", "an abbreviation names the same commit");
    assert.equal(await adapter.relation(side, Sha.of(tip)), "diverged");
    assert.equal(await adapter.relation("deadbeefdeadbeef", Sha.of(tip)), "unknown-commit");
    assert.equal(await adapter.relation("not-a-commit", Sha.of(tip)), "unknown-commit");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("relation() throws when git fails to answer, never reading it as unrelated", async () => {
  const failing = new GitMirrorReadAdapter("/repo", { run: async () => ({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository", timedOut: false }) });
  assert.equal(await failing.relation("abc1234", Sha.of("def5678")), "unknown-commit", "a commit git cannot resolve is unknown");

  let resolved = 0;
  const resolving: SandboxedBinaryRunner = {
    run: async (req) => req.args.includes("rev-parse")
      ? { exitCode: 0, stdout: (resolved++ === 0 ? "a" : "b").repeat(40) + "\n", stderr: "", timedOut: false }
      : { exitCode: 128, stdout: "", stderr: "fatal: corrupt", timedOut: false },
  };
  await assert.rejects(() => new GitMirrorReadAdapter("/repo", resolving).relation("abc1234", Sha.of("def5678")), /merge-base --is-ancestor failed/);
});
