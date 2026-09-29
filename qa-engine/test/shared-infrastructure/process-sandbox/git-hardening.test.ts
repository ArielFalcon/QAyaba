/* Behavioral tests for the git hardening every root git call on a sandbox-touched working copy goes through.
   The sandbox user owns the working copy, so it can rename the root-owned `.git` inside it and plant its own
   (config-driven command execution: core.fsmonitor, diff.external). Real git is run against each fixture;
   the planted command writes a marker file, so "did not execute" is observable. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as engineHardening from "../../../src/shared-infrastructure/process-sandbox/git-hardening.ts";
import {
  assertTrustedGitTree,
  hardenGitArgs,
  setSandboxGroup,
  setVerificationTimeout,
  UntrustedGitTreeError,
} from "../../../src/shared-infrastructure/process-sandbox/git-hardening.ts";
import { hardenDetachedGitArgs } from "../../../src/shared-infrastructure/process-sandbox/detached-git-hardening.ts";
import { InfraError } from "../../../src/shared-kernel/domain-error.ts";
import { closeGitDir, git, indexedGitlinks, makeEmbeddedRepo, makeGitlinkRepo, plantNestedRepo, ranPlantedCommand as ranMarker, writeMarkerCommand } from "./git-fixtures.ts";

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
    closeGitDir(repo); /* the ambient umask decides the modes git created; every test starts from an explicitly closed git dir */
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
  execFileSync("git", hardenGitArgs(args, cwd), { cwd, env: GIT_ENV, stdio: "ignore" });
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

const ORCHESTRATOR_UID = process.geteuid!();
const ORCHESTRATOR_GID = process.getegid!();

test("a git dir and config writable by the orchestrator's own group are accepted, as a umask-002 host creates them", () =>
  withFixture((f) => {
    chmodSync(join(f.repo, ".git"), 0o775);
    chmodSync(join(f.repo, ".git", "config"), 0o664);
    assert.doesNotThrow(() => assertTrustedGitTree(f.repo));
    assert.doesNotThrow(() => execFileSync("git", hardenGitArgs(["status", "--porcelain"], f.repo), { cwd: f.repo, env: GIT_ENV, stdio: "ignore" }));
  }));

test("a repository config writable by a group other than the orchestrator's own is refused and named, with the command that closes it", () =>
  withFixture((f) => {
    chmodSync(join(f.repo, ".git", "config"), 0o664);
    assert.throws(
      () => assertTrustedGitTree(f.repo, ORCHESTRATOR_UID, ORCHESTRATOR_GID + 1),
      (err: unknown) =>
        err instanceof UntrustedGitTreeError && err.message.includes(join(f.repo, ".git", "config")) && err.message.includes(`chmod -R g-w ${join(realpathSync(f.repo), ".git")}`),
    );
  }));

test("a git dir writable by a group other than the orchestrator's own is refused: the sandbox user may share it", () =>
  withFixture((f) => {
    chmodSync(join(f.repo, ".git"), 0o775);
    assert.throws(
      () => assertTrustedGitTree(f.repo, ORCHESTRATOR_UID, ORCHESTRATOR_GID + 1),
      (err: unknown) => err instanceof UntrustedGitTreeError && err.message.includes(`chmod -R g-w ${join(realpathSync(f.repo), ".git")}`),
    );
  }));

test("a git dir writable by the group the sandbox runs as is refused even when that is the orchestrator's own group", () =>
  withFixture((f) => {
    chmodSync(join(f.repo, ".git"), 0o775);
    setSandboxGroup(ORCHESTRATOR_GID);
    try {
      assert.throws(() => assertTrustedGitTree(f.repo), (err: unknown) => err instanceof UntrustedGitTreeError && /sandbox/.test(err.message));
    } finally {
      setSandboxGroup(undefined);
    }
    assert.doesNotThrow(() => assertTrustedGitTree(f.repo), "with no sandbox the orchestrator's own group is trusted again");
  }));

test("a git dir writable by any user stays refused whatever group owns it", () =>
  withFixture((f) => {
    chmodSync(join(f.repo, ".git"), 0o757);
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

test("hardening a call with no working copy yet (a clone, an ls-remote) checks nothing and still carries the hook hardening", () => {
  const args = hardenDetachedGitArgs(["clone", "https://example.com/x.git", "/tmp/x"]);
  assert.deepEqual(args.slice(-3), ["clone", "https://example.com/x.git", "/tmp/x"]);
  assert.ok(args.includes("core.hooksPath=/dev/null"), "the hardening flags precede the subcommand");
  assert.ok(!args.includes("-C") && !args.some((arg) => arg.startsWith("safe.directory")), "with no working copy there is nothing to point git at or to opt out");
});

test("a call that names no working copy is refused instead of being hardened as if there were none, and an empty path is not the process's own directory", () => {
  for (const missing of [null, undefined, ""]) {
    assert.throws(() => hardenGitArgs(["status"], missing as unknown as string), TypeError);
  }
});

/* A repository the sandbox controls, planted with a command git would run on `diff`; its config is writable by anyone,
   which is how a same-user test tells it from the orchestrator's own (the real one is owned by the sandbox user). */
function plantEvilRepo(f: Fixture): string {
  const evilRoot = join(f.root, "sandbox-controlled");
  execFileSync("git", ["clone", "-q", f.repo, evilRoot], { env: GIT_ENV, stdio: "ignore" });
  execFileSync("git", ["config", "diff.external", f.evil], { cwd: evilRoot });
  chmodSync(join(evilRoot, ".git", "config"), 0o666);
  mkdirSync(join(evilRoot, "inner"));
  return evilRoot;
}

test("a path that reaches another repository through a symlinked component is judged by the repository git really runs in", () =>
  withFixture((f) => {
    /* `up` lives in the trusted working copy but points into a directory of the sandbox's repository: judged by its
       lexical parent the call looks trusted, while git, run in the real directory, discovers the planted repository. */
    const evilRoot = plantEvilRepo(f);
    const up = join(f.repo, "up");
    symlinkSync(join(evilRoot, "inner"), up);

    let refusal: unknown;
    try {
      execFileSync("git", hardenGitArgs(["diff", "HEAD~1", "HEAD"], up), { cwd: up, env: GIT_ENV, stdio: "ignore" });
    } catch (err) {
      refusal = err;
    }
    assert.equal(ranPlantedCommand(f), false, "the planted command in the repository behind the link never ran");
    assert.ok(refusal instanceof UntrustedGitTreeError, "the call is refused before git starts, naming the repository it would really use");
  }));

test("git runs in the verified real directory whatever path or cwd the caller holds", () =>
  withFixture((f) => {
    const alias = join(f.root, "alias");
    symlinkSync(f.repo, alias);
    const top = execFileSync("git", hardenGitArgs(["rev-parse", "--show-toplevel"], alias), { cwd: f.root, env: GIT_ENV, encoding: "utf8" }).trim();
    assert.equal(top, realpathSync(f.repo));
  }));

test("a working copy that does not exist yet is hardened without a git dir to judge", () =>
  withFixture((f) => {
    const notYet = join(f.root, "not", "cloned", "yet");
    const args = hardenGitArgs(["status"], notYet);
    assert.deepEqual(args.slice(-1), ["status"]);
    assert.ok(args.includes(join(realpathSync(f.root), "not", "cloned", "yet")), "git is pointed at the resolved location");
  }));

/* Under GIT_TEST_ASSUME_DIFFERENT_OWNER git judges every tree owned by another user, as it does a working copy the
   sandbox user owns. */
const FOREIGN_OWNER_ENV = { ...GIT_ENV, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };

test("the working copy the check verified is opted out of git's ownership check", () =>
  withFixture((f) => {
    assert.doesNotThrow(() => execFileSync("git", hardenGitArgs(["status", "--porcelain"], f.repo), { cwd: f.repo, env: FOREIGN_OWNER_ENV, stdio: "ignore" }));
  }));

test("the ownership opt-out covers the verified working copy only: another repository reached with the same flags is still judged by git", () =>
  withFixture((f) => {
    const other = join(f.root, "other-repo");
    execFileSync("git", ["init", "-q", other], { env: GIT_ENV, stdio: "ignore" });
    /* Control: git itself refuses the foreign-owned tree when nothing opts it out. */
    assert.throws(() => execFileSync("git", ["-C", other, "rev-parse", "--git-dir"], { env: FOREIGN_OWNER_ENV, stdio: "ignore" }));
    /* The hardened flags for f.repo, then a redirect to the other tree: only f.repo may be trusted. */
    const args = hardenGitArgs(["-C", other, "rev-parse", "--git-dir"], f.repo);
    assert.throws(() => execFileSync("git", args, { cwd: f.repo, env: FOREIGN_OWNER_ENV, stdio: "ignore" }), "a wildcard opt-out would have trusted it too");
  }));

/* A committed gitlink is a submodule entry. The mirror never checks submodules out, so its directory is empty; the
   sandbox owns it and can put a repository of its own there. Root git that enters it spawns a child with GIT_DIR set
   explicitly (git's ownership check is skipped), and that child runs the planted config's filter as the orchestrator. */
function withGitlinkRepo(body: (f: { root: string; repo: string; marker: string; command: string; fixture: ReturnType<typeof makeGitlinkRepo> }) => void): void {
  const root = mkdtempSync(join(tmpdir(), "git-hardening-gitlink-"));
  try {
    const { marker, command } = writeMarkerCommand(root);
    const fixture = makeGitlinkRepo(root);
    body({ root, repo: fixture.repo, marker, command, fixture });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a repository the sandbox planted inside a committed gitlink is refused before any git runs, naming the planted git dir", () =>
  withGitlinkRepo(({ repo, marker, command, fixture }) => {
    plantNestedRepo(fixture, command);
    for (const args of [["status", "--porcelain"], ["add", "--", "."], ["checkout", "-B", "b"], ["diff", "--find-renames", "HEAD"]]) {
      assert.throws(
        () => hardenGitArgs(args, repo),
        (err: unknown) => err instanceof UntrustedGitTreeError && err.message.includes(join(repo, "sub", ".git")),
        `git ${args[0]} must not be started`,
      );
    }
    assert.equal(ranMarker(marker), false, "the check never enters the planted repository");
  }));

/* The refusal reaches logs, the run record and the operator's screen. The path it names comes from the repository the
   sandbox controls, so it must not be able to forge a line, drive the terminal, or fill a screen. */
test("the refusal for a planted repository names a path full of control characters only in escaped form", () => {
  const root = mkdtempSync(join(tmpdir(), "git-hardening-hostile-name-"));
  try {
    const fixture = makeGitlinkRepo(root);
    const hostile = "evil\nrefusing to run git on /trusted\u001b[31m-name";
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${fixture.subSha},${hostile}`], { cwd: fixture.repo });
    execFileSync("git", ["commit", "-qm", "hostile gitlink"], { cwd: fixture.repo, env: GIT_ENV });
    closeGitDir(fixture.repo);
    mkdirSync(join(fixture.repo, hostile, ".git"), { recursive: true });

    assert.throws(
      () => hardenGitArgs(["status"], fixture.repo),
      (err: unknown) => {
        assert.ok(err instanceof UntrustedGitTreeError);
        assert.doesNotMatch(err.message, /[\u0000-\u001f\u007f-\u009f]/, "a control character reached the message");
        assert.ok(err.message.includes("evil"), "the message still names the path it refused");
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the refusal for a planted repository under a very long gitlink path stays short", () => {
  const root = mkdtempSync(join(tmpdir(), "git-hardening-long-name-"));
  try {
    const fixture = makeGitlinkRepo(root);
    const long = Array.from({ length: 5 }, () => "d".repeat(150)).join("/");
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${fixture.subSha},${long}`], { cwd: fixture.repo });
    execFileSync("git", ["commit", "-qm", "long gitlink"], { cwd: fixture.repo, env: GIT_ENV });
    closeGitDir(fixture.repo);
    mkdirSync(join(fixture.repo, long, ".git"), { recursive: true });

    assert.throws(
      () => hardenGitArgs(["status"], fixture.repo),
      (err: unknown) => err instanceof UntrustedGitTreeError && err.message.length < 2000,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a gitfile the sandbox planted inside a committed gitlink is refused like a planted git dir", () =>
  withGitlinkRepo(({ repo, root }) => {
    writeFileSync(join(repo, "sub", ".git"), `gitdir: ${join(root, "elsewhere")}\n`);
    assert.throws(() => hardenGitArgs(["status"], repo), UntrustedGitTreeError);
  }));

test("a dangling symlink the sandbox planted as the git dir of a committed gitlink is refused", () =>
  withGitlinkRepo(({ repo, root }) => {
    symlinkSync(join(root, "does-not-exist"), join(repo, "sub", ".git"));
    assert.throws(() => hardenGitArgs(["status"], repo), UntrustedGitTreeError);
  }));

test("a planted repository inside a committed gitlink is refused for a call that runs in a subdirectory of the working copy", () =>
  withGitlinkRepo(({ repo, marker, command, fixture }) => {
    plantNestedRepo(fixture, command);
    assert.throws(() => hardenGitArgs(["status"], join(repo, "e2e")), UntrustedGitTreeError);
    assert.equal(ranMarker(marker), false);
  }));

test("a committed gitlink whose directory is empty or gone does not stop git, and the hardened status runs", () =>
  withGitlinkRepo(({ repo }) => {
    assert.doesNotThrow(() => hardenGitArgs(["status", "--porcelain"], repo), "an unpopulated gitlink directory is how a clone leaves it");
    assert.equal(execFileSync("git", hardenGitArgs(["status", "--porcelain"], repo), { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim(), "");
    rmSync(join(repo, "sub"), { recursive: true });
    assert.doesNotThrow(() => hardenGitArgs(["status", "--porcelain"], repo), "a missing directory holds nothing to enter");
  }));

/* A repository left under the working copy that is not a committed submodule (a test that runs `git init` inside the
   tree, a git dependency directory, or the sandbox's own doing). Staging the tree records it as a gitlink, and from
   then on the guard refuses every call on that working copy. */
test("staging the whole tree leaves an embedded repository out of the index, so the working copy stays usable", () =>
  withFixture((f) => {
    const { marker, command } = writeMarkerCommand(f.root);
    makeEmbeddedRepo(join(f.repo, "tmp-fixture-repo"), command);
    mkdirSync(join(f.repo, "e2e"));
    writeFileSync(join(f.repo, "e2e", "new.spec.ts"), "legit\n");

    execFileSync("git", hardenGitArgs(["add", "--", "."], f.repo), { cwd: f.repo, env: GIT_ENV, stdio: "ignore" });

    assert.deepEqual(indexedGitlinks(f.repo), [], "the embedded repository was staged as a gitlink");
    assert.match(execFileSync("git", hardenGitArgs(["diff", "--cached", "--name-only"], f.repo), { cwd: f.repo, env: GIT_ENV, encoding: "utf8" }), /e2e\/new\.spec\.ts/, "the legitimate file is still staged, and git still runs");
    assert.equal(ranMarker(marker), false, "adding never entered the embedded repository");
  }));

test("staging a path list leaves an embedded repository out even when the caller names it", () =>
  withFixture((f) => {
    makeEmbeddedRepo(join(f.repo, "tmp-fixture-repo"));
    writeFileSync(join(f.repo, "b.txt"), "b\n");

    execFileSync("git", hardenGitArgs(["add", "-N", "--", "tmp-fixture-repo/", "b.txt"], f.repo), { cwd: f.repo, env: GIT_ENV, stdio: "ignore" });

    assert.deepEqual(indexedGitlinks(f.repo), []);
    assert.doesNotThrow(() => hardenGitArgs(["status"], f.repo));
  }));

test("a nested repository nested inside untracked directories is left out of the index too", () =>
  withFixture((f) => {
    makeEmbeddedRepo(join(f.repo, "fixtures", "deep", "inner"));
    writeFileSync(join(f.repo, "fixtures", "keep.txt"), "keep\n");

    execFileSync("git", hardenGitArgs(["add", "--", "."], f.repo), { cwd: f.repo, env: GIT_ENV, stdio: "ignore" });

    assert.deepEqual(indexedGitlinks(f.repo), []);
    assert.match(execFileSync("git", ["ls-files"], { cwd: f.repo, encoding: "utf8" }), /fixtures\/keep\.txt/);
  }));

/* The guard looks at the index before the call; a repository the sandbox puts into a committed gitlink's directory
   afterwards must not be entered either. */
test("staging the whole tree never enters a committed gitlink that the sandbox populated after the check", () =>
  withGitlinkRepo(({ repo, marker, command, fixture }) => {
    const args = hardenGitArgs(["add", "--", "."], repo); /* the guard sees an empty submodule directory */
    plantNestedRepo(fixture, command);

    execFileSync("git", args, { cwd: repo, env: GIT_ENV, stdio: "ignore" });

    assert.equal(ranMarker(marker), false, "add ran the planted filter");
  }));

test("an embedded repository is left out when the add runs in a subdirectory of the working copy", () =>
  withFixture((f) => {
    makeEmbeddedRepo(join(f.repo, "e2e", "fixture-repo"));
    writeFileSync(join(f.repo, "e2e", "new.spec.ts"), "legit\n");

    execFileSync("git", hardenGitArgs(["add", "--", "."], join(f.repo, "e2e")), { cwd: f.repo, env: GIT_ENV, stdio: "ignore" });

    assert.deepEqual(indexedGitlinks(f.repo), []);
    assert.match(execFileSync("git", ["ls-files"], { cwd: f.repo, encoding: "utf8" }), /e2e\/new\.spec\.ts/);
  }));

test("a committed gitlink whose name holds glob characters excludes only itself, never legitimate files", () =>
  withFixture((f) => {
    const subSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf8" }).trim();
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${subSha},*.ts`], { cwd: f.repo });
    execFileSync("git", ["commit", "-qm", "gitlink with a glob name"], { cwd: f.repo, env: GIT_ENV });
    closeGitDir(f.repo);
    writeFileSync(join(f.repo, "legit.ts"), "export {};\n");

    execFileSync("git", hardenGitArgs(["add", "--", "."], f.repo), { cwd: f.repo, env: GIT_ENV, stdio: "ignore" });

    assert.match(execFileSync("git", ["ls-files"], { cwd: f.repo, encoding: "utf8" }), /legit\.ts/, "the glob-named gitlink swallowed a legitimate file");
  }));

test("a wildcard ownership opt-out in the host's git config does not widen the one the hardened flags grant", () =>
  withFixture((f) => {
    const other = join(f.root, "other-repo");
    execFileSync("git", ["init", "-q", other], { env: GIT_ENV, stdio: "ignore" });
    const wildcardConfig = join(f.root, "wildcard-gitconfig");
    writeFileSync(wildcardConfig, "[safe]\n\tdirectory = *\n");
    const env = { ...FOREIGN_OWNER_ENV, GIT_CONFIG_GLOBAL: wildcardConfig };
    /* Control: with the host's wildcard in place git trusts every tree, the foreign-owned one included. */
    assert.doesNotThrow(() => execFileSync("git", ["-C", other, "rev-parse", "--git-dir"], { env, stdio: "ignore" }));

    const args = hardenGitArgs(["-C", other, "rev-parse", "--git-dir"], f.repo);

    assert.throws(() => execFileSync("git", args, { cwd: f.repo, env, stdio: "ignore" }), "the host's wildcard trusted the other tree too");
    assert.doesNotThrow(() => execFileSync("git", hardenGitArgs(["status", "--porcelain"], f.repo), { cwd: f.repo, env, stdio: "ignore" }), "the verified working copy itself is still usable");
  }));

/* The walk stops at the first `.git` directory it finds, while git skips a `.git` that is not a repository and climbs
   to the next one. The repository the call would really use must be the one that was verified. */
test("a nearer .git directory that is not a repository is refused instead of being judged while git uses another repository", () =>
  withFixture((f) => {
    const { marker, command } = writeMarkerCommand(f.root);
    execFileSync("git", ["config", "filter.planted.clean", command], { cwd: f.repo });
    writeFileSync(join(f.repo, ".gitattributes"), "* filter=planted\n");
    writeFileSync(join(f.repo, "a.txt"), "zzz\n"); /* changed, so a status has to hash it through the filter */
    const sub = join(f.repo, "sub");
    mkdirSync(join(sub, ".git"), { recursive: true });
    chmodSync(join(sub, ".git"), 0o755);

    assert.throws(
      () => hardenGitArgs(["status", "--porcelain"], sub),
      (err: unknown) => err instanceof UntrustedGitTreeError && err.message.includes(realpathSync(f.repo)),
    );
    assert.equal(ranMarker(marker), false, "the check itself never runs a filter");
  }));

test("a git dir that git cannot use at all is refused rather than left to fail inside the git call", () =>
  withFixture((f) => {
    const lone = join(f.root, "lone");
    mkdirSync(join(lone, ".git"), { recursive: true });
    chmodSync(join(lone, ".git"), 0o755);
    assert.throws(() => hardenGitArgs(["status"], lone), UntrustedGitTreeError);
  }));

test("the module the engine imports offers no way to build the hardening flags without verifying a working copy", () => {
  assert.equal("baseGitHardeningFlags" in engineHardening, false);
});

/* The verification queries run git themselves. A machine that cannot run git (no binary, no memory, the process killed)
   says nothing about the working copy, so it is an infrastructure failure, never a claim that the tree is untrusted:
   a security refusal is acted on (the recovery deletes the mirror), a transient fault must not be. Fake git binaries
   sit on PATH: the process boundary is the only double. */
function withFakeGit(script: string, body: () => void): void {
  const bin = mkdtempSync(join(tmpdir(), "fake-git-"));
  const previousPath = process.env.PATH;
  try {
    writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${previousPath}`;
    body();
  } finally {
    process.env.PATH = previousPath;
    rmSync(bin, { recursive: true, force: true });
  }
}

const isInfra = (err: unknown): boolean => err instanceof InfraError;

test("git running out of memory while verifying is an infrastructure failure, not an untrusted tree", () =>
  withFixture((f) => {
    withFakeGit('echo "fatal: Out of memory, malloc failed (tried to allocate 4096 bytes)" >&2\nexit 128', () => {
      assert.throws(() => hardenGitArgs(["status"], f.repo), isInfra);
    });
  }));

test("git killed by a signal while verifying is an infrastructure failure, not an untrusted tree", () =>
  withFixture((f) => {
    withFakeGit("kill -9 $$", () => {
      assert.throws(() => hardenGitArgs(["status"], f.repo), isInfra);
    });
  }));

test("a missing git binary is an infrastructure failure, not an untrusted tree", () =>
  withFixture((f) => {
    const empty = mkdtempSync(join(tmpdir(), "no-git-"));
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = empty;
      assert.throws(() => hardenGitArgs(["status"], f.repo), isInfra);
    } finally {
      process.env.PATH = previousPath;
      rmSync(empty, { recursive: true, force: true });
    }
  }));

test("git saying it cannot use the git dir stays a refusal of the tree", () =>
  withFixture((f) => {
    withFakeGit('echo "fatal: not a git repository (or any of the parent directories): .git" >&2\nexit 128', () => {
      assert.throws(() => hardenGitArgs(["status"], f.repo), UntrustedGitTreeError);
    });
  }));

/* The verification queries run synchronously in front of every git call the server makes. A stalled filesystem must
   not freeze the whole process, and a listing that cannot have changed is not asked for again. */
test("a git query that never returns is cut off and reported as an infrastructure failure", () =>
  withFixture((f) => {
    withFakeGit("exec sleep 3", () => {
      setVerificationTimeout(1);
      try {
        assert.throws(() => hardenGitArgs(["status"], f.repo), isInfra);
      } finally {
        setVerificationTimeout(undefined);
      }
    });
  }));

/* A stand-in git that records every call, then runs the real one. */
function withLoggingGit(body: (calls: () => string[]) => void): void {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = mkdtempSync(join(tmpdir(), "logging-git-"));
  const log = join(bin, "calls.log");
  const previousPath = process.env.PATH;
  try {
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${previousPath}`;
    body(() => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []));
  } finally {
    process.env.PATH = previousPath;
    rmSync(bin, { recursive: true, force: true });
  }
}

const listingsOf = (calls: string[]): number => calls.filter((line) => line.includes("ls-files --stage")).length;
const HOUR_AGO = new Date(Date.now() - 3_600_000);
const ageIndex = (repo: string): void => utimesSync(join(repo, ".git", "index"), HOUR_AGO, HOUR_AGO);

test("the submodule listing is not asked of git again while the index has not changed", () =>
  withFixture((f) => {
    ageIndex(f.repo);
    withLoggingGit((calls) => {
      hardenGitArgs(["status"], f.repo);
      hardenGitArgs(["status"], f.repo);
      hardenGitArgs(["diff"], f.repo);
      assert.equal(listingsOf(calls()), 1);
    });
  }));

test("an index written moments ago is never served from the listing cache", () =>
  withFixture((f) => {
    withLoggingGit((calls) => {
      hardenGitArgs(["status"], f.repo);
      hardenGitArgs(["status"], f.repo);
      assert.equal(listingsOf(calls()), 2, "a same-tick rewrite cannot be told apart by its timestamp");
    });
  }));

test("a gitlink added to the index after the listing was cached is seen, and a repository planted in it is refused", () =>
  withGitlinkRepo(({ repo, fixture, command }) => {
    ageIndex(repo);
    hardenGitArgs(["status"], repo); /* caches the listing: only `sub` */
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${fixture.subSha},later`], { cwd: repo, env: GIT_ENV });
    ageIndex(repo); /* the rewrite is old enough to be cached again, so only the index's identity can tell it changed */
    makeEmbeddedRepo(join(repo, "later"), command);

    assert.throws(() => hardenGitArgs(["status"], repo), UntrustedGitTreeError);
  }));

test("an index rewritten to the same size and timestamp is still noticed", () =>
  withGitlinkRepo(({ repo, command }) => {
    const indexPath = join(repo, ".git", "index");
    ageIndex(repo);
    hardenGitArgs(["status"], repo); /* caches the listing: only `sub` */
    /* The same index with the gitlink renamed to a path of the same length (and the trailing checksum redone), put in place the way git does: a new file renamed over the old one. */
    const bytes = readFileSync(indexPath);
    const at = bytes.lastIndexOf("sub\0");
    assert.ok(at > 0, "the gitlink's path is in the index");
    bytes.write("sug", at);
    createHash("sha1").update(bytes.subarray(0, bytes.length - 20)).digest().copy(bytes, bytes.length - 20);
    const rewritten = join(repo, ".git", "index.rewritten");
    writeFileSync(rewritten, bytes);
    assert.deepEqual(execFileSync("git", ["ls-files", "--stage"], { cwd: repo, env: { ...GIT_ENV, GIT_INDEX_FILE: rewritten }, encoding: "utf8" }).includes("\tsug"), true, "the rewritten index is one git accepts");
    renameSync(rewritten, indexPath);
    ageIndex(repo); /* the same timestamp as before */
    makeEmbeddedRepo(join(repo, "sug"), command);

    assert.throws(() => hardenGitArgs(["status"], repo), UntrustedGitTreeError);
  }));
