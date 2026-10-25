/* The graph workspace is the commit's tree as the orchestrator chooses to show it to the engine: the declared languages and their manifests, never the repo's own engine config, pre-built index or .gitignore, never a link, and never by touching the mirror. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportWorkspace, selectWorkspacePaths, type WorkspaceScope } from "../../../src/shared-infrastructure/code-graph/codegraph-workspace.ts";
import { SandboxedBinaryRunnerAdapter } from "../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter.ts";
import { ProcessKillAdapter } from "../../../src/shared-infrastructure/process-sandbox/process-kill.adapter.ts";
import { closeGitDir, git } from "../process-sandbox/git-fixtures.ts";

const SCOPE: WorkspaceScope = { extensions: ["ts", "java"], manifests: ["package.json", "pom.xml"], exclude: ["web/generated/**"] };

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

/* A mirror whose commit holds what a workspace must take and everything it must not. */
function mirror(root: string): { dir: string; sha: string } {
  const dir = join(root, "mirror");
  mkdirSync(dir);
  git(dir, "init", "-q");
  write(dir, "web/package.json", "{}\n");
  write(dir, "web/src/a.ts", "export const a = 1;\n");
  write(dir, "web/src/b.TS", "export const b = 1;\n");
  write(dir, "web/generated/api.ts", "export const g = 1;\n");
  write(dir, "web/src/hidden.ts", "export const hidden = 1;\n");
  write(dir, "web/.gitignore", "src/hidden.ts\n");
  write(dir, "api/pom.xml", "<project/>\n");
  write(dir, "api/src/A.java", "class A {}\n");
  write(dir, "README.md", "# readme\n");
  write(dir, "codegraph.json", '{ "exclude": ["web/"] }\n');
  write(dir, ".codegraph/codegraph.db", "planted index\n");
  symlinkSync("/etc/passwd", join(dir, "web/src/link.ts"));
  git(dir, "add", "-A", "-f");
  git(dir, "commit", "-qm", "c");
  closeGitDir(dir);
  return { dir, sha: git(dir, "rev-parse", "HEAD") };
}

const runner = () => new SandboxedBinaryRunnerAdapter({ processKill: new ProcessKillAdapter() });

test("the workspace holds the declared languages' tracked files and their manifests, and nothing the repo could steer the engine with", async () => {
  const root = mkdtempSync(join(tmpdir(), "cg-ws-"));
  try {
    const m = mirror(root);
    const dir = join(root, "ws");
    const result = await exportWorkspace({ git: runner(), mirrorDir: m.dir, sha: m.sha, dir, scope: SCOPE, sandbox: null });
    assert.ok(result.ok, result.ok ? "" : result.error.reason);
    for (const kept of ["web/package.json", "web/src/a.ts", "web/src/b.TS", "web/src/hidden.ts", "api/pom.xml", "api/src/A.java"]) {
      assert.equal(existsSync(join(dir, kept)), true, `${kept} is in the workspace`);
    }
    assert.equal(readFileSync(join(dir, "web/src/a.ts"), "utf8"), "export const a = 1;\n");
    for (const dropped of ["web/generated/api.ts", "web/.gitignore", "README.md", "codegraph.json", ".codegraph/codegraph.db", "web/src/link.ts"]) {
      assert.equal(existsSync(join(dir, dropped)), false, `${dropped} is not in the workspace`);
    }
    assert.equal(result.ok && result.value.fileCount, 6);
    assert.equal(lstatSync(join(dir, ".codegraph")).isDirectory(), true, "the store directory is ready, empty of anything the repo shipped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("building the workspace leaves the mirror's index, HEAD and working tree as they were", async () => {
  const root = mkdtempSync(join(tmpdir(), "cg-ws-"));
  try {
    const m = mirror(root);
    write(m.dir, "web/src/a.ts", "export const a = 2; // local edit\n");
    const before = { status: git(m.dir, "status", "--porcelain"), head: git(m.dir, "rev-parse", "HEAD"), index: readFileSync(join(m.dir, ".git", "index")) };
    const result = await exportWorkspace({ git: runner(), mirrorDir: m.dir, sha: m.sha, dir: join(root, "ws"), scope: SCOPE, sandbox: null });
    assert.ok(result.ok);
    assert.equal(git(m.dir, "status", "--porcelain"), before.status);
    assert.equal(git(m.dir, "rev-parse", "HEAD"), before.head);
    assert.deepEqual(readFileSync(join(m.dir, ".git", "index")), before.index);
    assert.equal(readFileSync(join(root, "ws", "web/src/a.ts"), "utf8"), "export const a = 1;\n", "the workspace shows the commit, not the working tree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a commit with no file of a declared language, or an id that is not a commit, builds no workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "cg-ws-"));
  try {
    const m = mirror(root);
    const none = await exportWorkspace({ git: runner(), mirrorDir: m.dir, sha: m.sha, dir: join(root, "ws1"), scope: { extensions: ["py"], manifests: [], exclude: [] }, sandbox: null });
    assert.equal(none.ok, false);
    assert.equal(existsSync(join(root, "ws1")), false);
    const bad = await exportWorkspace({ git: runner(), mirrorDir: m.dir, sha: "--output=/tmp/x", dir: join(root, "ws2"), scope: SCOPE, sandbox: null });
    assert.equal(bad.ok, false);
    assert.equal(existsSync(join(root, "ws2")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the path selection keeps regular files only and matches extensions whatever their case", () => {
  const listing = [
    "100644 blob aaaa\tsrc/a.ts",
    "100755 blob bbbb\tsrc/run.TS",
    "120000 blob cccc\tsrc/link.ts",
    "160000 commit dddd\tvendor/sub",
    "100644 blob eeee\tsrc/.codegraph/x.ts",
  ].join("\0");
  assert.deepEqual(selectWorkspacePaths(listing, { extensions: ["ts"], manifests: [], exclude: [] }), ["src/a.ts", "src/run.TS"]);
});
