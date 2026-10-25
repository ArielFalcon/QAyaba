/*
 * The graph workspace: what the code-graph engine reads, built by the orchestrator from the files tracked at the run's commit,
 * never the mirror itself. The mirror is a watched repo's working copy: indexing it would let the repo configure the engine
 * (its own `codegraph.json`), hand it a pre-built index (`.codegraph/`), hide tracked files from it (a `.gitignore` the engine
 * honours) or land the store inside the repo. Here the orchestrator lists the commit's tree, keeps the regular files of the
 * declared languages and their manifests, drops the engine's config, every `.gitignore` and whatever the app's config
 * excludes, and checks exactly those paths out into the workspace through a throwaway index, so the mirror's index, HEAD
 * and working tree are untouched. The workspace's files are root-owned and read-only to the sandbox; only `.codegraph/`,
 * where the engine writes its store, belongs to the sandbox. The workspace lies in the run's work dir, which the sandbox
 * owns, so whoever reads it back checks it is still the directory built here (the store cache's publish does).
 */

import { chmodSync, chownSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, matchesGlob } from "node:path";
import { err, ok, type Result } from "../../shared-kernel/result.ts";
import { hardenGitArgs } from "../process-sandbox/git-hardening.ts";
import type { Sandbox } from "../process-sandbox/sandbox.ts";
import { scrubEnv } from "../process-sandbox/scrub-env.ts";
import type { SandboxedBinaryRunner } from "../process-sandbox/sandboxed-binary-runner.ts";

/* The engine's own store directory and config file: never taken from a repo. */
export const STORE_DIR = ".codegraph";
const ENGINE_CONFIG = "codegraph.json";
const GIT_TIMEOUT_MS = 120_000;
/* A tree entry of `git ls-tree -r -z`: "<mode> <type> <oid>\t<path>". Only regular files (100644, 100755) are kept: a link (120000) or a submodule (160000) never reaches the workspace. */
const TREE_ENTRY = /^(100644|100755) blob [0-9a-f]+\t(.+)$/s;

/* What a workspace holds: the declared languages' source and the manifests the engine reads to recognise a framework. */
export interface WorkspaceScope {
  /* File extensions, without the dot, lower case (`ts`, `java`). */
  extensions: readonly string[];
  /* File names whose presence tells the engine the stack (`package.json`, `pom.xml`). */
  manifests: readonly string[];
  /* Repo-relative globs the app's config keeps out of the index. */
  exclude: readonly string[];
}

export interface WorkspaceExport {
  dir: string;
  fileCount: number;
}

/* The paths of a commit's tree the workspace takes, in tree order. */
export function selectWorkspacePaths(treeListing: string, scope: WorkspaceScope): string[] {
  const extensions = new Set(scope.extensions.map((e) => e.toLowerCase()));
  const manifests = new Set(scope.manifests);
  const out: string[] = [];
  for (const entry of treeListing.split("\0")) {
    const match = TREE_ENTRY.exec(entry);
    if (!match) continue;
    const path = match[2]!;
    const name = basename(path);
    const segments = path.split("/");
    if (name === ".gitignore" || path === ENGINE_CONFIG || segments.includes(STORE_DIR)) continue;
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    if (!extensions.has(ext) && !manifests.has(name)) continue;
    if (scope.exclude.some((glob) => matchesGlob(path, glob))) continue;
    out.push(path);
  }
  return out;
}

export interface ExportWorkspaceInput {
  git: SandboxedBinaryRunner;
  mirrorDir: string;
  sha: string;
  /* Created here; must not exist. Its parent is the run's work dir. */
  dir: string;
  scope: WorkspaceScope;
  sandbox: Sandbox | null;
}

async function runGit(input: ExportWorkspaceInput, args: string[], env: Record<string, string> = {}): Promise<Result<string, { reason: string }>> {
  try {
    const r = await input.git.run({ command: "git", args: hardenGitArgs(args, input.mirrorDir), cwd: input.mirrorDir, env: { ...scrubEnv(), ...env }, timeoutMs: GIT_TIMEOUT_MS });
    if (r.timedOut) return err({ reason: `git ${args[0]} timed out` });
    if (r.exitCode !== 0) return err({ reason: `git ${args[0]} exited ${r.exitCode}: ${r.stderr.slice(0, 400)}` });
    return ok(r.stdout);
  } catch (e) {
    return err({ reason: e instanceof Error ? e.message : String(e) });
  }
}

/* Builds the workspace of `sha`. A failure removes what was made, so a partial workspace is never indexed. */
export async function exportWorkspace(input: ExportWorkspaceInput): Promise<Result<WorkspaceExport, { reason: string }>> {
  if (!/^[0-9a-f]{7,64}$/.test(input.sha)) return err({ reason: `not a commit id: ${input.sha}` });
  const tree = await runGit(input, ["ls-tree", "-r", "-z", "--full-tree", input.sha]);
  if (!tree.ok) return tree;
  const paths = selectWorkspacePaths(tree.value, input.scope);
  if (paths.length === 0) return err({ reason: "the commit holds no file of a declared language" });

  mkdirSync(input.dir, { mode: 0o755 });
  const scratch = join(input.dir, STORE_DIR);
  try {
    mkdirSync(scratch, { mode: 0o700 });
    const pathspecs = join(scratch, "paths");
    writeFileSync(pathspecs, `${paths.join("\0")}\0`, { mode: 0o600 });
    const checkout = await runGit(
      input,
      ["--work-tree", input.dir, "checkout", input.sha, "--pathspec-from-file", pathspecs, "--pathspec-file-nul"],
      { GIT_INDEX_FILE: join(scratch, "index"), GIT_LITERAL_PATHSPECS: "1" },
    );
    rmSync(pathspecs, { force: true });
    rmSync(join(scratch, "index"), { force: true });
    if (!checkout.ok) throw new Error(checkout.error.reason);
    chmodSync(input.dir, 0o755);
    /* The one place the engine writes: its store. */
    if (input.sandbox) chownSync(scratch, input.sandbox.uid, input.sandbox.gid);
    return ok({ dir: input.dir, fileCount: paths.length });
  } catch (e) {
    rmSync(input.dir, { recursive: true, force: true });
    return err({ reason: e instanceof Error ? e.message : String(e) });
  }
}
