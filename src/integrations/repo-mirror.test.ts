import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenGitArgs as engineHardenGitArgs } from "../../qa-engine/src/shared-infrastructure/process-sandbox/git-hardening";
import { hardenDetachedGitArgs as engineHardenDetachedGitArgs } from "../../qa-engine/src/shared-infrastructure/process-sandbox/detached-git-hardening";
import { closeGitDir, GIT_ENV, makeGitlinkRepo, plantNestedRepo, ranPlantedCommand, writeMarkerCommand } from "../../qa-engine/test/shared-infrastructure/process-sandbox/git-fixtures";
import { ensureMirror, ensureMirrorAtBranch, getCommitDiff, listChangedSpecs, getCommitsBehind, getCommitMessage, getHeadSha, resolveRef, getChangedFilesInRange, getRangeDiff, hardenGitArgs, hardenDetachedGitArgs, MirrorDeps } from "./repo-mirror";

/* authHeaderArgs() depends on GITHUB_TOKEN and the remote URL on GIT_REMOTE_BASE;
   clear both to isolate the logic (token-bearing tests set GITHUB_TOKEN per-test).
 */
delete process.env.GITHUB_TOKEN;
delete process.env.GIT_REMOTE_BASE;

/* exists: a boolean covers both the mirror dir and the stale-lock probe; a function
   lets a test answer differently per path (e.g. "dir exists but no index.lock").
 */
function recorder(exists: boolean | ((path: string) => boolean)): MirrorDeps & { calls: string[][]; removed: string[] } {
  const calls: string[][] = [];
  const removed: string[] = [];
  return {
    calls,
    removed,
    root: "/tmp/mirrors",
    exists: typeof exists === "function" ? exists : () => exists,
    removeFile: (path) => {
      removed.push(path);
    },
    git: async (args) => {
      calls.push(args);
      return "diff-output";
    },
  };
}

test("hardenGitArgs prepends the hook hardening before the git subcommand and opts nothing out of git's ownership check without a working copy", () => {
  const out = hardenDetachedGitArgs(["remote", "set-url", "origin", "https://example.com/x.git"]);
  /* core.hooksPath=/dev/null → no repo hook runs as the orchestrator (root-RCE guard). */
  assert.deepEqual(out.slice(0, 2), ["-c", "core.hooksPath=/dev/null"]);
  assert.ok(!out.some((arg) => arg.startsWith("safe.directory")), "there is no verified working copy to opt out for");
  assert.deepEqual(out.slice(-4), ["remote", "set-url", "origin", "https://example.com/x.git"]);
});

test("hardenGitArgs opts only the verified working copy out of git's ownership check, never a wildcard", () => {
  const repo = mkdtempSync(join(tmpdir(), "hardening-ownership-"));
  try {
    execFileSync("git", ["init", "-q", repo]);
    closeGitDir(repo);
    const out = hardenGitArgs(["status"], repo);
    assert.ok(out.includes(`safe.directory=${realpathSync(repo)}`), "the real path of the verified tree is the opt-out");
    assert.ok(!out.includes("safe.directory=*"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the shell hardens a git call exactly like the engine does, for a call with no working copy and for one with", () => {
  const repo = mkdtempSync(join(tmpdir(), "hardening-parity-"));
  try {
    execFileSync("git", ["init", "-q", repo]);
    closeGitDir(repo);
    for (const args of [[], ["status", "--porcelain"], ["diff", "--no-color", "abc1234^", "abc1234"]]) {
      assert.deepEqual(engineHardenDetachedGitArgs(args), hardenDetachedGitArgs(args));
      assert.deepEqual(engineHardenGitArgs(args, repo), hardenGitArgs(args, repo));
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("clones, force-checks out and cleans when the working copy does not exist", async () => {
  const d = recorder(false);
  const dir = await ensureMirror("org/app", "abc1234", d);
  assert.equal(dir, "/tmp/mirrors/org__app");
  assert.deepEqual(d.calls[0], ["clone", "https://github.com/org/app.git", "/tmp/mirrors/org__app"]);
  assert.deepEqual(d.calls[1], ["checkout", "-f", "abc1234"]);
  assert.deepEqual(d.calls[2], ["clean", "-fd", "-e", "node_modules"]);
});

test("existing mirror: scrubs origin URL, fetches, force-checks out and cleans", async () => {
  const d = recorder((p) => !p.endsWith("index.lock"));
  await ensureMirror("org/app", "abc1234", d);
  assert.deepEqual(d.calls[0], ["remote", "set-url", "origin", "https://github.com/org/app.git"]);
  assert.deepEqual(d.calls[1], ["fetch", "--no-recurse-submodules", "origin"]);
  assert.deepEqual(d.calls[2], ["checkout", "-f", "abc1234"]);
  assert.deepEqual(d.calls[3], ["clean", "-fd", "-e", "node_modules"]);
});

/* ── Security: the push token must never be persisted into the mirror ─────────
   The mirrors volume is mounted into the agent container (its session cwd, with
   bash/read tools): a token in the clone URL would land in .git/config and hand
   the credential to the LLM and to watched-repo lifecycle scripts.
 */

const INSTEADOF_FLAG = "url.https://x-access-token:sekret-token@github.com/.insteadOf=https://github.com/";

test("clone URL is tokenless; auth rides the transient -c insteadOf rewrite", async () => {
  process.env.GITHUB_TOKEN = "sekret-token";
  try {
    const d = recorder(false);
    await ensureMirror("org/app", "abc1234", d);
    assert.deepEqual(d.calls[0], ["-c", INSTEADOF_FLAG, "clone", "https://github.com/org/app.git", "/tmp/mirrors/org__app"]);
    /* Nothing after the -c rewrite (the args git persists/uses as URL) carries the token. */
    for (const arg of d.calls[0]!.slice(2)) assert.ok(!arg.includes("sekret-token"), `token leaked into ${arg}`);
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test("ensureMirrorAtBranch clone URL is tokenless with the insteadOf rewrite too", async () => {
  process.env.GITHUB_TOKEN = "sekret-token";
  try {
    const d = recorder(false);
    await ensureMirrorAtBranch("org/app", "main", d);
    assert.deepEqual(d.calls[0], ["-c", INSTEADOF_FLAG, "clone", "https://github.com/org/app.git", "/tmp/mirrors/org__app"]);
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test("existing mirror: origin is reset to the tokenless URL before fetch (scrubs token persisted by older clones)", async () => {
  process.env.GITHUB_TOKEN = "sekret-token";
  try {
    const d = recorder((p) => !p.endsWith("index.lock"));
    await ensureMirror("org/app", "abc1234", d);
    assert.deepEqual(d.calls[0], ["remote", "set-url", "origin", "https://github.com/org/app.git"]);
    assert.deepEqual(d.calls[1], ["-c", INSTEADOF_FLAG, "fetch", "--no-recurse-submodules", "origin"]);
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test("resolveRef queries ls-remote with the tokenless URL through the insteadOf rewrite", async () => {
  process.env.GITHUB_TOKEN = "sekret-token";
  try {
    const d = gitStub(() => "a".repeat(40) + "\trefs/heads/main\n");
    const sha = await resolveRef("org/app", "main", d);
    assert.equal(sha, "a".repeat(40));
    assert.deepEqual(d.calls[0], ["-c", INSTEADOF_FLAG, "ls-remote", "https://github.com/org/app.git", "main"]);
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

/* ── Stale git lock self-heal ──────────────────────────────────────────────────
   The queue is strictly sequential and only the orchestrator performs git writes,
   so an index.lock present at the start of a run is stale by definition.
 */

test("removes a stale .git/index.lock before any git command", async () => {
  const d = recorder(true); /* mirror dir AND lock exist */
  await ensureMirror("org/app", "abc1234", d);
  assert.deepEqual(d.removed, ["/tmp/mirrors/org__app/.git/index.lock"]);
});

test("ensureMirrorAtBranch also removes a stale index.lock", async () => {
  const d = recorder(true);
  await ensureMirrorAtBranch("org/app", "main", d);
  assert.deepEqual(d.removed, ["/tmp/mirrors/org__app/.git/index.lock"]);
});

test("does not touch index.lock when absent", async () => {
  const d = recorder((p) => !p.endsWith("index.lock"));
  await ensureMirror("org/app", "abc1234", d);
  assert.deepEqual(d.removed, []);
});

test("does not probe for a lock on the clone path (no mirror, no lock)", async () => {
  const d = recorder(false);
  await ensureMirror("org/app", "abc1234", d);
  assert.deepEqual(d.removed, []);
});

/* A custom git stub whose output depends on the args (so the parent-count probe and
   the diff can return different things).
 */
function gitStub(reply: (args: string[]) => string): MirrorDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return { calls, root: "/tmp/mirrors", exists: () => true, removeFile: () => {}, git: async (args) => { calls.push(args); return reply(args); } };
}

test("getCommitDiff of a single-parent commit uses plain git show", async () => {
  /* recorder's git returns "diff-output" for the %P probe → one token → single parent. */
  const d = recorder(true);
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
    const d: MirrorDeps = {
      root,
      exists: () => true,
      removeFile: () => {},
      git: async (args, cwd) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }),
    };

    assert.deepEqual(await listChangedSpecs(fixture.repo, ".", d), ["new.spec.ts"]);
    assert.equal(ranPlantedCommand(marker), false, "the status ran the planted filter");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getCommitsBehind rejects a non-hex sha before spawning git (injection defense)", async () => {
  const d = gitStub(() => "5");
  await assert.rejects(() => getCommitsBehind("/dir", "--output=/etc/passwd", "abc1234def", d), /invalid commit sha/);
  await assert.rejects(() => getCommitsBehind("/dir", "abc1234def", "$(rm -rf)", d), /invalid commit sha/);
  assert.equal(d.calls.length, 0); /* never reached git */
});

test("getCommitsBehind returns the commit count for valid hex shas", async () => {
  const d = gitStub(() => "12\n");
  assert.equal(await getCommitsBehind("/dir", "abc1234def", "def5678abc", d), 12);
});

test("getCommitsBehind propagates a git error (can't determine — orphaned/force-pushed sha)", async () => {
  const d = gitStub(() => { throw new Error("fatal: unknown revision"); });
  await assert.rejects(() => getCommitsBehind("/dir", "abc1234def", "def5678abc", d), /unknown revision/);
});

test("rejects a non-hex sha (git argument-injection defense) before spawning git", async () => {
  const d = recorder(true);
  await assert.rejects(() => ensureMirror("org/app", "--output=/etc/passwd", d), /invalid commit sha/);
  await assert.rejects(() => getCommitDiff("/dir", "not-a-sha", d), /invalid commit sha/);
  assert.equal(d.calls.length, 0); /* never reached git */
});

test("ensureMirror flattens a nested repo path (replaceAll, not just first slash)", async () => {
  const d = recorder(false);
  const dir = await ensureMirror("org/sub/app", "abc1234", d);
  assert.equal(dir, "/tmp/mirrors/org__sub__app");
});

test("ensureMirrorAtBranch clones when missing and checks out origin/<branch>", async () => {
  const d = recorder(false);
  const dir = await ensureMirrorAtBranch("org/shop-front", "main", d);
  assert.equal(dir, "/tmp/mirrors/org__shop-front");
  assert.equal(d.calls[0]?.[0], "clone");
  assert.ok(d.calls.some((c) => c[0] === "checkout" && c.includes("origin/main")));
  assert.ok(d.calls.some((c) => c[0] === "clean"));
});

test("ensureMirrorAtBranch fetches when the mirror exists", async () => {
  const d = recorder(true);
  await ensureMirrorAtBranch("org/shop-front", "main", d);
  assert.ok(d.calls.some((c) => c.includes("fetch")));
  assert.ok(!d.calls.some((c) => c[0] === "clone"));
});

test("ensureMirrorAtBranch rejects a branch name that could be parsed as a git option", async () => {
  const d = recorder(true);
  await assert.rejects(() => ensureMirrorAtBranch("org/x", "--upload-pack=evil", d));
  await assert.rejects(() => ensureMirrorAtBranch("org/x", "a..b", d));
});

test("ensureMirror propagates git clone failure (network timeout / auth failure)", async () => {
  const d: MirrorDeps = {
    root: "/tmp/mirrors",
    exists: () => false,
    removeFile: () => {},
    git: async () => { throw new Error("git clone failed: connection timeout"); },
  };
  await assert.rejects(() => ensureMirror("org/app", "abc1234", d), /git clone failed/);
});

test("ensureMirror propagates git checkout failure", async () => {
  const d: MirrorDeps = {
    root: "/tmp/mirrors",
    exists: () => true,
    removeFile: () => {},
    git: async (args) => {
      if (args[0] === "checkout") throw new Error("git checkout failed: unknown revision");
      return "ok";
    },
  };
  await assert.rejects(() => ensureMirror("org/app", "abc1234", d), /git checkout failed/);
});

test("ensureMirror propagates git fetch failure", async () => {
  const d: MirrorDeps = {
    root: "/tmp/mirrors",
    exists: () => true,
    removeFile: () => {},
    git: async (args) => {
      if (args.includes("fetch")) throw new Error("git fetch failed: 401 Unauthorized");
      return "ok";
    },
  };
  await assert.rejects(() => ensureMirror("org/app", "abc1234", d), /git fetch failed/);
});

test("getCommitDiff propagates git show failure", async () => {
  const d: MirrorDeps = {
    root: "/tmp/mirrors",
    exists: () => true,
    removeFile: () => {},
    git: async () => { throw new Error("git show failed: bad object"); },
  };
  await assert.rejects(() => getCommitDiff("/dir", "abc1234", d), /git show failed/);
});

test("listChangedSpecs propagates git status failure", async () => {
  const d: MirrorDeps = {
    root: "/tmp/mirrors",
    exists: () => true,
    removeFile: () => {},
    git: async () => { throw new Error("git status failed: not a git repository"); },
  };
  await assert.rejects(() => listChangedSpecs("/dir", "e2e", d), /git status failed/);
});

test("getCommitMessage propagates git show failure", async () => {
  const d: MirrorDeps = {
    root: "/tmp/mirrors",
    exists: () => true,
    removeFile: () => {},
    git: async () => { throw new Error("git show failed"); },
  };
  await assert.rejects(() => getCommitMessage("/dir", "abc1234", d), /git show failed/);
});

test("getHeadSha resolves the mirror's checked-out HEAD through the injected git dependency, trimmed", async () => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const d: MirrorDeps = {
    root: "/tmp/mirrors",
    exists: () => true,
    removeFile: () => {},
    git: async (args, cwd) => {
      calls.push({ args, cwd });
      return "abc1234567890abc1234567890abc1234567890\n";
    },
  };
  const sha = await getHeadSha("/dir", d);
  assert.equal(sha, "abc1234567890abc1234567890abc1234567890");
  assert.deepEqual(calls, [{ args: ["rev-parse", "HEAD"], cwd: "/dir" }], "must resolve HEAD via the injected git dependency, not a direct shell-out");
});

test("getHeadSha propagates git rev-parse failure (never swallowed to an empty sha)", async () => {
  const d: MirrorDeps = {
    root: "/tmp/mirrors",
    exists: () => true,
    removeFile: () => {},
    git: async () => { throw new Error("rev-parse failed: not a git repository"); },
  };
  await assert.rejects(() => getHeadSha("/dir", d), /rev-parse failed/);
});

test("resolveRef propagates git ls-remote failure", async () => {
  const d: MirrorDeps = {
    root: "/tmp/mirrors",
    exists: () => true,
    removeFile: () => {},
    git: async () => { throw new Error("ls-remote failed: Could not resolve host"); },
  };
  await assert.rejects(() => resolveRef("org/app", "main", d), /ls-remote failed/);
});

test("ensureMirrorAtBranch propagates git clone failure", async () => {
  const d: MirrorDeps = {
    root: "/tmp/mirrors",
    exists: () => false,
    removeFile: () => {},
    git: async () => { throw new Error("git clone failed"); },
  };
  await assert.rejects(() => ensureMirrorAtBranch("org/app", "main", d), /git clone failed/);
});

test("ensureMirrorAtBranch propagates git checkout failure", async () => {
  const d: MirrorDeps = {
    root: "/tmp/mirrors",
    exists: () => true,
    removeFile: () => {},
    git: async (args) => {
      if (args[0] === "checkout") throw new Error("git checkout failed");
      return "ok";
    },
  };
  await assert.rejects(() => ensureMirrorAtBranch("org/app", "main", d), /git checkout failed/);
});

test("getChangedFilesInRange: rejects non-hex baseSha before spawning git", async () => {
  const d = gitStub(() => "");
  await assert.rejects(() => getChangedFilesInRange("/dir", "--injection", "abc1234def", d), /invalid commit sha/);
  assert.equal(d.calls.length, 0);
});

test("getChangedFilesInRange: rejects non-hex headSha before spawning git", async () => {
  const d = gitStub(() => "");
  await assert.rejects(() => getChangedFilesInRange("/dir", "abc1234def", "$(rm -rf /)", d), /invalid commit sha/);
  assert.equal(d.calls.length, 0);
});

test("getChangedFilesInRange: returns empty list when baseSha === headSha (degenerate / single-commit PR)", async () => {
  const sha = "abc1234def";
  const d = gitStub(() => "src/foo.ts\n"); /* should not be called */
  const result = await getChangedFilesInRange("/dir", sha, sha, d);
  assert.deepEqual(result, [], "same-SHA range degrades to empty list without calling git");
  assert.equal(d.calls.length, 0, "git must not be called for degenerate range");
});

test("getChangedFilesInRange: returns sorted deduplicated list of changed files across range", async () => {
  const base = "aaaa1111";
  const head = "bbbb2222";
  const d = gitStub(() => "src/b.ts\nsrc/a.ts\nsrc/a.ts\ne2e/flows/login.spec.ts\n");
  const result = await getChangedFilesInRange("/dir", base, head, d);
  assert.deepEqual(result, ["e2e/flows/login.spec.ts", "src/a.ts", "src/b.ts"], "result must be sorted and deduplicated");
  assert.deepEqual(d.calls[0], ["diff", "--name-only", `${base}..${head}`], "correct git command");
});

test("getChangedFilesInRange: handles empty output (no files changed in range)", async () => {
  const d = gitStub(() => "\n  \n");
  const result = await getChangedFilesInRange("/dir", "aaaa1111", "bbbb2222", d);
  assert.deepEqual(result, []);
});

test("getChangedFilesInRange: propagates git diff failure", async () => {
  const d = gitStub(() => { throw new Error("git diff failed: no common ancestor"); });
  await assert.rejects(() => getChangedFilesInRange("/dir", "aaaa1111", "bbbb2222", d), /git diff failed/);
});

test("getChangedFilesInRange: uses diff --name-only with baseSha..headSha revspec", async () => {
  const base = "aabb1234";
  const head = "ccdd5678";
  let capturedArgs: string[] = [];
  const d: MirrorDeps = {
    root: "/tmp/mirrors",
    exists: () => true,
    removeFile: () => {},
    git: async (args) => { capturedArgs = args; return "src/changed.ts\n"; },
  };
  await getChangedFilesInRange("/dir", base, head, d);
  assert.deepEqual(capturedArgs, ["diff", "--name-only", `${base}..${head}`]);
});

test("getRangeDiff diffs base..head as one range", async () => {
  const d = gitStub(() => "range-diff");
  const diff = await getRangeDiff("/dir", "aaaa1111", "bbbb2222", d);
  assert.equal(diff, "range-diff");
  assert.deepEqual(d.calls[0], ["diff", "aaaa1111..bbbb2222"]);
});

test("getRangeDiff rejects a non-hex base sha", async () => {
  const d = gitStub(() => "");
  await assert.rejects(() => getRangeDiff("/dir", "not-a-sha", "bbbb2222", d), /invalid commit sha/);
});

test("getRangeDiff rejects a non-hex head sha", async () => {
  const d = gitStub(() => "");
  await assert.rejects(() => getRangeDiff("/dir", "aaaa1111", "not-a-sha", d), /invalid commit sha/);
});

/* Security: a failing git spawn's error message includes the FULL command line — including the
   -c url.insteadOf config that carries the inline token. That error propagates to logs (the
   maintainer's session-failed handler logged a real PAT in plaintext). realGit must scrub any
   inline credential from the error before it escapes the spawn boundary.
 */
test("realGit scrubs inline x-access-token credentials from a failing spawn's error message", async () => {
  const { realGit } = await import("./repo-mirror");
  const fakeToken = "ghp_FAKEsecret1234567890abcdefghijklmnop";
  await assert.rejects(
    /* A guaranteed-to-fail git invocation whose argv carries the credential exactly like
       authHeaderArgs() builds it (insteadOf rewrite with the token inline).
     */
    realGit(["-c", `url.https://x-access-token:${fakeToken}@github.com/.insteadOf=https://github.com/`, "clone", "file:///nonexistent/definitely-missing.git", "/tmp/qa-scrub-probe-target"], undefined),
    (err: Error) => {
      assert.ok(!err.message.includes(fakeToken), "the token must NOT appear in the error message");
      /* RedactionPortAdapter (env+pattern, src/orchestrator/sanitizer.ts), which replaces the whole
         egress boundary — not the old module-local util/redact.ts "[REDACTED_CREDENTIAL]" literal.
         Intentional, documented consequence of consolidating on one mechanism, not a regression —
         the diagnostic-shape goal (command stays readable, credential span gone) is preserved.
       */
      assert.match(err.message, /\[REDACTED\]/, "the credential span must be redacted, not dropped (the command shape stays diagnosable)");
      return true;
    },
  );
});

/* prefix — must also be scrubbed. This is the secondary branch scrubGitError has always covered
   (the literal token-value split) but that was, until now, untested; delegating to redactSecrets
   must not silently drop it.
 */
test("realGit scrubs the raw GITHUB_TOKEN value (no x-access-token prefix) from a failing spawn's error message", async () => {
  const { realGit } = await import("./repo-mirror");
  const rawToken = "ghp_BareTokenNoPrefix9876543210abcdefgh";
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = rawToken;
  try {
    await assert.rejects(
      /* Embed the bare token value directly in a failing command's argv (e.g. as a URL query
         param) — no x-access-token: prefix, so only the live-value branch can catch it.
       */
      realGit(["clone", `file:///nonexistent/definitely-missing.git?token=${rawToken}`, "/tmp/qa-scrub-probe-target-2"], undefined),
      (err: Error) => {
        assert.ok(!err.message.includes(rawToken), "the raw token value must NOT appear in the error message");
        assert.match(err.message, /\[REDACTED\]/, "the shared redaction placeholder must appear in its place");
        return true;
      },
    );
  } finally {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

/* The sandbox owns a working copy after a code/e2e run and can swap the root-owned `.git` for one of its own;
   its config would plant a command git runs as the orchestrator on the next call (checkout, status, publish). */
test("realGit refuses a working copy whose git dir was swapped and never runs its planted command", async () => {
  const { realGit } = await import("./repo-mirror");
  const root = mkdtempSync(join(tmpdir(), "realgit-swapped-git-"));
  const repo = join(root, "repo");
  const marker = join(root, "marker");
  try {
    execFileSync("git", ["init", "-q", repo]);
    closeGitDir(repo);
    writeFileSync(join(repo, "a.txt"), "x\n");
    const planted = join(root, "planted-git");
    cpSync(join(repo, ".git"), planted, { recursive: true });
    const evil = join(root, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\necho ran >> "${marker}"\nexit 0\n`, { mode: 0o755 });
    execFileSync("git", ["config", "--file", join(planted, "config"), "core.fsmonitor", evil]);
    rmSync(join(repo, ".git"), { recursive: true });
    symlinkSync(planted, join(repo, ".git"));

    await assert.rejects(() => realGit(["status", "--porcelain"], repo), /git dir|\.git/i);
    assert.equal(existsSync(marker) && readFileSync(marker, "utf8").includes("ran"), false, "git never ran against the swapped git dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("realGit still runs against an ordinary working copy", async () => {
  const { realGit } = await import("./repo-mirror");
  const repo = mkdtempSync(join(tmpdir(), "realgit-ordinary-"));
  try {
    execFileSync("git", ["init", "-q", repo]);
    closeGitDir(repo);
    writeFileSync(join(repo, "a.txt"), "x\n");
    assert.match(await realGit(["status", "--porcelain"], repo), /a\.txt/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
