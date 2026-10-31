/* REAL git-status fixture tests for the e2e publish excludes. The existing
   the publish step tests in run-engine-factory.test.ts use a fake `git` fn that only records
   argv — that style is deliberately insufficient here: an array-membership assertion on the exclude
   config would have PASSED on the anchoring bug (the string ".qa/coverage/" WAS already in the
   array; it just excluded nothing because of gitignore mid-pattern-slash anchoring). Only a real
   commit-content assertion, against a real throwaway git repo, proves the pattern actually excludes
   the real e2e/.qa/coverage/ path. `push` is intercepted (never shelled out — no real remote exists
   in a throwaway fixture repo); every other git subcommand (status/checkout/add/commit) runs for
   real, exercising the publish step's full publish() orchestration exactly as production wires it.
 */
import { buildPublishWorkspace } from "./engine-root";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, unlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfinement, publishWiring } from "./run-engine-factory";
import { realGit } from "./repo-mirror";
import { closeGitDir, indexedGitlinks, makeEmbeddedRepo } from "../../engine/test/shared-infrastructure/process-sandbox/git-fixtures";
import { defaultSpecWriteDeps, writeOwnedSpecFile } from "../../engine/src/shared-infrastructure/spec-path-confinement";
import type { RunMode } from "@kernel/run-mode";

/* The publish step of a run as the engine wires it: the context's policy over the shell's git wiring. */
function publishStep(mode: RunMode, git?: (args: string[], cwd?: string) => Promise<string>, writeExcludesFn?: (dir: string, patterns: readonly string[]) => void) {
  return buildPublishWorkspace({ ...publishWiring(mode, git, writeExcludesFn) });
}


/* The bare git subcommand of an argv, skipping leading `-c <key> <value>` pairs (the publish step's
   commit/push decorations prepend -c flags) — mirrors run-engine-factory.test.ts's own
   subcommandOf helper (duplicated locally; that file does not export it).
 */
function subcommandOf(args: string[]): string | undefined {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i];
}

/* A REAL git fn that shells out to git for every subcommand EXCEPT push (there is no real remote in
   a throwaway fixture repo) — push is captured, never executed, so the publish step's full publish()
   orchestration (write excludes -> status -> checkout -B -> add -> commit -> push) can run
   end-to-end against a real repo while staying network-free.
 */
function realGitNoPush(defaultCwd: string): { git: (args: string[], cwd?: string) => Promise<string>; pushCalls: string[][] } {
  const pushCalls: string[][] = [];
  const git = async (args: string[], cwd: string = defaultCwd): Promise<string> => {
    if (subcommandOf(args) === "push") {
      pushCalls.push(args);
      return "";
    }
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString();
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(`git ${args.join(" ")} failed: ${err.stderr ?? err.stdout ?? String(e)}`);
    }
  };
  return { git, pushCalls };
}

/* A throwaway repo with ONE base commit on the default branch — mirrors a real mirrorDir checkout.
   Every scenario branches off this baseline via the publish step's own `checkout -B`.
 */
function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "qa-publish-excludes-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" };
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  closeGitDir(repo);
  git("config", "user.email", "t@t.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "base\n");
  git("add", "README.md");
  git("commit", "-qm", "chore: base");
  return repo;
}

/* Every file path committed in HEAD's own commit (vs. its parent) — the definitive "what got
   staged and pushed" evidence.
 */
function committedPaths(repo: string): string[] {
  const out = execFileSync("git", ["show", "--pretty=format:", "--name-only", "HEAD"], { cwd: repo, encoding: "utf8" });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function writeFile(repo: string, relPath: string, content = "{}\n"): void {
  const full = join(repo, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/* ── e2e target ─────────────────────────────────────────────────────────────────────────────────── */

test("e2e target: cross-repo service-context snapshot is never staged (leak fix, spec 'Cross-repo run does not leak service context into the PR diff')", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n");
    writeFile(repo, "e2e/.qa/service-context/other-repo/snapshot.json");

    const { git } = realGitNoPush(repo);
    const vcsWrite = publishStep("diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/leaktest1", sha: "leaktest1" });

    assert.equal(result.changed, true, "the legitimate spec file must still register as a change");
    const paths = committedPaths(repo);
    assert.ok(paths.includes("e2e/checkout.spec.ts"), "the legitimate e2e spec must be staged");
    assert.ok(
      !paths.some((p) => p.startsWith("e2e/.qa/service-context/")),
      `service-context must never be staged into the suite PR — committed paths: ${JSON.stringify(paths)}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("e2e target: coverage dumps and measured.json are excluded from a real staged commit (anchoring-bug fix)", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n");
    writeFile(repo, "e2e/.qa/coverage/run-123/dump.json");
    writeFile(repo, "e2e/.qa/measured.json");

    const { git } = realGitNoPush(repo);
    const vcsWrite = publishStep("diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/covtest1", sha: "covtest1" });

    assert.equal(result.changed, true);
    const paths = committedPaths(repo);
    assert.ok(paths.includes("e2e/checkout.spec.ts"));
    assert.ok(
      !paths.some((p) => p.startsWith("e2e/.qa/coverage/")),
      `coverage dumps must be excluded — pre-fix ".qa/coverage/" is anchored to the repo root (mid-pattern slash) and matches nothing under e2e/ — committed paths: ${JSON.stringify(paths)}`,
    );
    assert.ok(
      !paths.includes("e2e/.qa/measured.json"),
      `measured.json must be excluded — committed paths: ${JSON.stringify(paths)}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("e2e target: e2e/.auth/ session files are never published", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n");
    writeFile(repo, "e2e/.auth/user.json", "{\"cookies\":[]}\n");
    writeFile(repo, "e2e/.auth/client.p12", "cert-bytes");

    const { git } = realGitNoPush(repo);
    const vcsWrite = publishStep("diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/authtest1", sha: "authtest1" });

    assert.equal(result.changed, true);
    const paths = committedPaths(repo);
    assert.ok(paths.includes("e2e/checkout.spec.ts"));
    assert.ok(
      !paths.some((p) => p.startsWith("e2e/.auth/")),
      `auth session files must be excluded — committed paths: ${JSON.stringify(paths)}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/* The manifest is written through a temporary file renamed over it, so a run that dies between the two leaves the temporary file in e2e/.qa, and the publish stages the whole e2e/ tree. The file is made by the real writer, with a rename that never happens, so the name is the one production gives it. */
test("e2e target: a temporary file left by an interrupted manifest write is never staged, and the manifest itself is", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n");
    const root = { mirrorDir: repo, specDir: join(repo, "e2e") };
    writeOwnedSpecFile(root, ".qa/manifest.json", "[]\n");
    writeOwnedSpecFile(root, ".qa/manifest.json", "[{\"id\":\"half-written", { ...defaultSpecWriteDeps, rename: () => {} });
    assert.ok(readdirSync(join(repo, "e2e", ".qa")).some((name) => name.endsWith(".tmp")), "the interrupted write left its temporary file");

    const { git } = realGitNoPush(repo);
    const vcsWrite = publishStep("diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/tmptest1", sha: "tmptest1" });

    assert.equal(result.changed, true);
    const paths = committedPaths(repo);
    assert.ok(paths.includes("e2e/checkout.spec.ts"));
    assert.ok(paths.includes("e2e/.qa/manifest.json"), `the manifest is published — committed paths: ${JSON.stringify(paths)}`);
    assert.ok(
      !paths.some((p) => p.endsWith(".tmp")),
      `a temporary file of an interrupted write must be excluded — committed paths: ${JSON.stringify(paths)}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("e2e target: node_modules/ (unprefixed, no mid-pattern slash) still excludes at ANY depth, including nested under e2e/ — existing legitimate exclude remains intact", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n");
    writeFile(repo, "e2e/node_modules/some-pkg/index.js", "module.exports = {};\n");

    const { git } = realGitNoPush(repo);
    const vcsWrite = publishStep("diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/nmtest1", sha: "nmtest1" });

    assert.equal(result.changed, true);
    const paths = committedPaths(repo);
    assert.ok(paths.includes("e2e/checkout.spec.ts"));
    assert.ok(
      !paths.some((p) => p.startsWith("e2e/node_modules/")),
      `node_modules/ must exclude at ANY depth (no leading/mid slash), including nested under e2e/ — committed paths: ${JSON.stringify(paths)}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/* The tracked-file guard also applies to e2e: a tree-wide .env suffix can live under e2e/. */

test("e2e target: a TRACKED, agent-modified e2e/fixtures/creds.env is never published (the guard must be wired for e2e too — *.env is a tree-wide suffix match, not root-anchored)", async () => {
  const originalEnv = "FIXTURE_BASE_URL=http://localhost:3000\n";
  const repo = mkdtempSync(join(tmpdir(), "qa-publish-e2e-tracked-env-"));
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.com" };
    const gitSync = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
    gitSync("init", "-q");
    closeGitDir(repo);
    gitSync("config", "user.email", "t@t.com");
    gitSync("config", "user.name", "t");
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n");
    writeFile(repo, "e2e/fixtures/creds.env", originalEnv); /* already tracked, exactly like a real watched repo's own fixture */
    gitSync("add", "-A");
    gitSync("commit", "-qm", "chore: base with tracked e2e fixture env");

    /* Agent tampers with the already-tracked fixture, embedding a live secret. */
    writeFile(repo, "e2e/fixtures/creds.env", `${originalEnv}AWS_SECRET_ACCESS_KEY=AKIAABCDEFGHIJKLMNOP\n`);
    writeFile(repo, "e2e/login.spec.ts", "test('y', () => {});\n");

    const { git } = realGitNoPush(repo);
    const vcsWrite = publishStep("diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/e2eenvtest1", sha: "e2eenvtest1" });

    assert.equal(result.changed, true, "the legitimate new spec must still register as a change");
    const paths = committedPaths(repo);
    assert.ok(paths.includes("e2e/login.spec.ts"), "a legitimate new e2e spec must still be staged");
    assert.ok(
      !paths.includes("e2e/fixtures/creds.env"),
      `a tampered TRACKED e2e/fixtures/creds.env must never be published — committed paths: ${JSON.stringify(paths)}`,
    );
    assert.equal(
      readFileSync(join(repo, "e2e/fixtures/creds.env"), "utf8"),
      originalEnv,
      "e2e/fixtures/creds.env working-tree content must be restored to HEAD, not left tampered with the embedded secret",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});


/* ── no-false-positive checks: every OTHER root-anchored denylist entry, when placed under e2e/,
   must NOT match (Dockerfile is exact-match, .github/ is a dir-prefix, docker-compose* is a
   prefix — none of them are tree-wide, so an e2e/-nested path never collides) ─────────────────────
 */

test("e2e target (negative): e2e/Dockerfile, e2e/.github/workflows/x.yml and e2e/docker-compose.yml are legitimate e2e content and are still published (root-anchored entries do not falsely match under e2e/)", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n");
    writeFile(repo, "e2e/Dockerfile", "FROM node:24\n"); /* legitimate e2e-owned fixture, not root-anchored */
    writeFile(repo, "e2e/.github/workflows/x.yml", "name: fixture\n");
    writeFile(repo, "e2e/docker-compose.yml", "services: {}\n");

    const { git } = realGitNoPush(repo);
    const vcsWrite = publishStep("diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/e2enofalsepos1", sha: "e2enofalsepos1" });

    assert.equal(result.changed, true);
    const paths = committedPaths(repo);
    for (const legit of ["e2e/checkout.spec.ts", "e2e/Dockerfile", "e2e/.github/workflows/x.yml", "e2e/docker-compose.yml"]) {
      assert.ok(paths.includes(legit), `${legit} is legitimate e2e content and must still be published — committed paths: ${JSON.stringify(paths)}`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});



/* The publish kind follows the run's mode. A context-mode run reaching "pr" must not fall through to
   the e2e pathspec ("e2e"), staging the WHOLE e2e/ tree — seed fixtures, specs, everything —
   instead of just the FE<->BE architecture map. See the publish adapter's
   publishContext, whose CONTEXT_ADD = ["e2e/.qa/context.json"] stages ONLY that one file.
 */

test("context target: a context-mode publish stages ONLY e2e/.qa/context.json, never e2e specs or seed fixtures", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "e2e/.qa/context.json", '{"routes":[]}\n'); /* the ONLY file a context-mode publish should ever stage */
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n"); /* must NOT be staged by a context-mode publish */
    writeFile(repo, "e2e/playwright.config.ts", "export default {};\n"); /* seed fixture — must NOT be staged either */

    const { git } = realGitNoPush(repo);
    const vcsWrite = publishStep("context", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/contexttest1", sha: "contexttest1" });

    assert.equal(result.changed, true, "the context.json change must register");
    const paths = committedPaths(repo);
    assert.deepEqual(paths, ["e2e/.qa/context.json"], `a context-mode publish must stage ONLY the context artifact — committed paths: ${JSON.stringify(paths)}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("context target: no changes to context.json -> reports changed:false even when other e2e/ files changed (scoped status check, not a whole-e2e/ scan)", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n"); /* an e2e/ change that is NOT the context artifact */

    const { git } = realGitNoPush(repo);
    const vcsWrite = publishStep("context", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/contexttest2", sha: "contexttest2" });

    assert.equal(result.changed, false, "a context-mode publish must only observe changes to e2e/.qa/context.json, not the wider e2e/ tree");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/* ── a repository left under the working copy ──────────────────────────────────────────────────── */

/* The production git fn (hardened, verifying the working copy first) with only the push intercepted. */
function hardenedGitNoPush(): (args: string[], cwd?: string) => Promise<string> {
  return async (args, cwd) => (subcommandOf(args) === "push" ? "" : realGit(args, cwd));
}

test("e2e target: a repository left under the working copy is not published as a gitlink, and the next publish still works", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "e2e/orders.spec.ts", "test('x', () => {});\n");
    makeEmbeddedRepo(join(repo, "e2e", "tmp-fixture-repo"));

    const vcsWrite = publishStep("diff", hardenedGitNoPush());
    const first = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/embedded1", sha: "embedded1" });

    assert.equal(first.changed, true);
    assert.ok(committedPaths(repo).includes("e2e/orders.spec.ts"), "the legitimate test is still published");
    assert.deepEqual(indexedGitlinks(repo), [], "the embedded repository was recorded as a gitlink");

    writeFile(repo, "e2e/more.spec.ts", "test('y', () => {});\n");
    const second = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/embedded2", sha: "embedded2" });
    assert.equal(second.changed, true, "the working copy was left unusable by the first publish");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the confinement pass as production wires it removes a repository left under the working copy", async () => {
  const repo = initRepo();
  try {
    makeEmbeddedRepo(join(repo, "tmp-fixture-repo"));

    const result = await buildConfinement().enforce(repo);

    assert.equal(existsSync(join(repo, "tmp-fixture-repo")), false);
    assert.deepEqual(result.reverted, ["tmp-fixture-repo/"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("e2e target: the run_spec probe directory and the fault-injection counters are never published, even when the sweep left them", async () => {
  const repo = initRepo();
  try {
    writeFile(repo, "e2e/checkout.spec.ts", "test('x', () => {});\n");
    writeFile(repo, "e2e/.qa-probe/try.spec.ts", "test('probe', () => {});\n");
    writeFile(repo, "e2e/.qa-probe/deep/more.spec.ts", "test('probe', () => {});\n");
    writeFile(repo, "e2e/.qa/fault-injection/run-1/injected-1.json", "{\"corrupted\":1}\n");

    const { git } = realGitNoPush(repo);
    const vcsWrite = publishStep("diff", git);
    const result = await vcsWrite.publish({ mirrorDir: repo, branch: "qa-bot/probetest1", sha: "probetest1" });

    assert.equal(result.changed, true);
    const paths = committedPaths(repo);
    assert.ok(paths.includes("e2e/checkout.spec.ts"));
    assert.deepEqual(paths.filter((p) => p.includes(".qa-probe") || p.includes("fault-injection")), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
