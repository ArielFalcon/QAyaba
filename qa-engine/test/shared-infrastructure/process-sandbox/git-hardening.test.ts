/* Behavioral tests for the git hardening every root git call on a sandbox-touched working copy goes through.
   The sandbox user owns the working copy, so it can rename the root-owned `.git` inside it and plant its own
   (config-driven command execution: core.fsmonitor, diff.external). Real git is run against each fixture;
   the planted command writes a marker file, so "did not execute" is observable. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertTrustedGitTree,
  hardenGitArgs,
  UntrustedGitTreeError,
} from "../../../src/shared-infrastructure/process-sandbox/git-hardening.ts";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" };

interface Fixture {
  root: string;
  repo: string;
  marker: string;
  evil: string;
}

/* A working copy with two commits, plus a "planted command" script that records that it ran. */
function withFixture(body: (f: Fixture) => void | Promise<void>): Promise<void> | void {
  const root = mkdtempSync(join(tmpdir(), "git-hardening-"));
  const repo = join(root, "repo");
  const marker = join(root, "marker");
  const evil = join(root, "evil.sh");
  const cleanup = (): void => rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(repo);
    writeFileSync(evil, `#!/bin/sh\necho ran >> "${marker}"\nexit 0\n`, { mode: 0o755 });
    const git = (...args: string[]): void => void execFileSync("git", args, { cwd: repo, env: GIT_ENV, stdio: "ignore" });
    git("init", "-q");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-qm", "first");
    writeFileSync(join(repo, "a.txt"), "two\n");
    git("commit", "-qam", "second");
    const result = body({ root, repo, marker, evil });
    if (result instanceof Promise) return result.finally(cleanup);
    cleanup();
  } catch (err) {
    cleanup();
    throw err;
  }
}

const ranPlantedCommand = (f: Fixture): boolean => existsSync(f.marker) && readFileSync(f.marker, "utf8").includes("ran");

/* Run git the way a hardened caller does; the error (if any) is the caller's to see. */
function hardenedGit(f: Fixture, cwd: string, ...args: string[]): void {
  execFileSync("git", hardenGitArgs(args, null), { cwd, env: GIT_ENV, stdio: "ignore" });
}

test("a regular working copy owned by the trusted user is accepted", () =>
  withFixture(({ repo }) => {
    assert.doesNotThrow(() => assertTrustedGitTree(repo));
    const args = hardenGitArgs(["status", "--porcelain"], repo);
    assert.deepEqual(args.slice(-2), ["status", "--porcelain"], "the caller's subcommand runs last, after the hardening flags");
  }));

test("a directory outside any repository is left to git, which refuses it on its own", () =>
  withFixture(({ root }) => {
    const stray = join(root, "not-a-repo");
    mkdirSync(stray);
    assert.doesNotThrow(() => assertTrustedGitTree(stray));
    assert.throws(() => execFileSync("git", ["-C", stray, "rev-parse", "HEAD"], { stdio: "ignore" }), "git itself has nothing to run against here");
  }));

test("a git dir the trusted user does not own is refused and named", () =>
  withFixture(({ repo }) => {
    const uid = process.geteuid!();
    assert.throws(
      () => assertTrustedGitTree(repo, uid + 1),
      (err: unknown) => err instanceof UntrustedGitTreeError && err.message.includes(join(repo, ".git")),
    );
  }));

test("a git dir the sandbox swapped in beside the renamed original is refused before git runs", () =>
  withFixture((f) => {
    /* The sandbox owns the working copy, so it may rename the root-owned `.git` and `git init` its own. Its own
       config plants a command that git would run as the orchestrator on the next call. */
    renameSync(join(f.repo, ".git"), join(f.repo, ".git-original"));
    execFileSync("git", ["init", "-q"], { cwd: f.repo });
    execFileSync("git", ["config", "core.fsmonitor", f.evil], { cwd: f.repo });
    const sandboxUid = process.geteuid!();
    const orchestratorUid = sandboxUid + 1; /* the swapped dir belongs to the sandbox user, not to the orchestrator */
    assert.throws(() => assertTrustedGitTree(f.repo, orchestratorUid), UntrustedGitTreeError);
    assert.equal(ranPlantedCommand(f), false, "the check itself never runs the planted command");
  }));

test("a symlinked git dir is refused: a link to a directory the sandbox controls is not the orchestrator's git dir", () =>
  withFixture((f) => {
    const elsewhere = join(f.root, "elsewhere-git");
    cpSync(join(f.repo, ".git"), elsewhere, { recursive: true });
    rmSync(join(f.repo, ".git"), { recursive: true });
    symlinkSync(elsewhere, join(f.repo, ".git"));
    assert.throws(() => assertTrustedGitTree(f.repo), UntrustedGitTreeError);
  }));

test("a gitfile that redirects git to another directory is refused", () =>
  withFixture((f) => {
    const elsewhere = join(f.root, "elsewhere-git");
    cpSync(join(f.repo, ".git"), elsewhere, { recursive: true });
    rmSync(join(f.repo, ".git"), { recursive: true });
    writeFileSync(join(f.repo, ".git"), `gitdir: ${elsewhere}\n`);
    assert.throws(() => assertTrustedGitTree(f.repo), UntrustedGitTreeError);
  }));

test("a repository config anyone can write is refused: its commands would run as the orchestrator", () =>
  withFixture((f) => {
    chmodSync(join(f.repo, ".git", "config"), 0o666);
    assert.throws(
      () => assertTrustedGitTree(f.repo),
      (err: unknown) => err instanceof UntrustedGitTreeError && err.message.includes(join(f.repo, ".git", "config")),
    );
  }));

test("a git dir anyone can write is refused: its config could be replaced", () =>
  withFixture((f) => {
    chmodSync(join(f.repo, ".git"), 0o777);
    assert.throws(() => assertTrustedGitTree(f.repo), UntrustedGitTreeError);
  }));

test("a subdirectory is judged by the git dir git would discover for it, nearest first", () =>
  withFixture((f) => {
    const sub = join(f.repo, "e2e");
    mkdirSync(sub);
    assert.doesNotThrow(() => assertTrustedGitTree(sub), "the parent's git dir is the one git would use");
    execFileSync("git", ["init", "-q"], { cwd: sub });
    assert.throws(() => assertTrustedGitTree(sub, process.geteuid! () + 1), UntrustedGitTreeError, "a nested git dir is the nearest one, so it is the one judged");
  }));

test("a core.fsmonitor command in the repository config does not run under the hardened args", () =>
  withFixture((f) => {
    execFileSync("git", ["config", "core.fsmonitor", f.evil], { cwd: f.repo });
    hardenedGit(f, f.repo, "status", "--porcelain");
    assert.equal(ranPlantedCommand(f), false, "the hardening overrides the config-driven fsmonitor on the command line");
  }));

test("a bare repository that is implicitly discovered in a subdirectory is not used under the hardened args", () =>
  withFixture((f) => {
    /* A bare repository's own config is trusted by git once it is discovered; a planted diff.external would run. */
    const sub = join(f.repo, "sub");
    execFileSync("git", ["clone", "-q", "--bare", f.repo, sub], { env: GIT_ENV, stdio: "ignore" });
    execFileSync("git", ["config", "diff.external", f.evil], { cwd: sub });
    try {
      hardenedGit(f, sub, "diff", "HEAD~1", "HEAD");
    } catch {
      /* git refusing is the point */
    }
    assert.equal(ranPlantedCommand(f), false);
  }));

test("hardening a call with no working copy yet (a clone, an ls-remote) checks nothing and still carries the flags", () => {
  const args = hardenGitArgs(["clone", "https://example.com/x.git", "/tmp/x"], null);
  assert.deepEqual(args.slice(-3), ["clone", "https://example.com/x.git", "/tmp/x"]);
  assert.ok(args.length > 3, "the hardening flags precede the subcommand");
});
