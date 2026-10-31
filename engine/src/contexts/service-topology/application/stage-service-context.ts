/*
 * Stages a READ-ONLY, bounded snapshot of a related microservice (OpenAPI/contract files + the
 * triggering commit's diff and post-change file content) inside the front repo working copy,
 * under e2e/.qa/service-context/<repo-slug>/. The agent session is rooted at the front copy —
 * sibling-mirror absolute paths trip opencode serve's external_directory gate and hang. Staging
 * in-root keeps every read inside the session. Path is a pure function of (workingCopyDir, repo),
 * not sha, so composition can compute it before checkout. Every fs/git side effect is injected
 * via ServiceContextStagingPort.
 *
 * Both sides are directories the agent can write into: the service's mirror (a repository's tree
 * can hold committed links, and the agent can plant a link, a named pipe or a file of any size in
 * any mirror) and the front's working copy the context is staged into. So the service's files are
 * listed by the one walk of the files of a repository and read through the strict, capped read: a
 * link is never followed and a named pipe never opened, and what cannot be used is omitted with a
 * reason of the module's own. The staging directory is emptied, made and written through the strict
 * calls rooted at the working copy, so nothing is made or written through a link the agent planted
 * in it.
 */

import { dirname, join } from "node:path";
import { rethrowIfUntrusted } from "@kernel/domain-error.ts";
import { assertCommitSha } from "@kernel/git-revision.ts";
import type { ServiceContextStagingPort } from "./ports/service-context-staging.port.ts";

export interface StageServiceContextInput {
  workingCopyDir: string;  /* the FRONT repo's working copy (the agent session root) */
  service: { repo: string; mirrorDir: string; openapi?: string | string[] };
  sha?: string;  /* the triggering commit — diff/changed-files staging only runs when present */
}

export interface StagedServiceContext {
  dir: string;
  manifestPath: string;
}

export interface OmittedEntry {
  path: string;
  reason: string;
}

export interface ServiceContextManifest {
  repo: string;
  sha?: string;
  stagedAt: string;  /* ISO, derived from the injected clock — never a direct Date.now() read */
  contracts: string[];  /* repo-relative paths staged under contracts/ */
  changed: string[];  /* repo-relative paths staged under changed/ */
  omitted: OmittedEntry[];  /* anything considered but NOT staged, with why — no silent truncation */
}

/*
 * Determinism + boundedness caps (task spec): omissions are always recorded in the manifest,
 * never silently dropped.
 */
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;

function repoSlug(repo: string): string {
  return repo.replaceAll("/", "__");
}

/*
 * The ONE formula for the staged directory — shared by this module (where it writes) and
 * run-engine-factory.ts (which threads it, synchronously, into triggerService.mirrorDir /
 * services[].mirrorDir at composition time). Never re-derive this elsewhere.
 */
export function serviceContextDir(workingCopyDir: string, repo: string): string {
  return join(workingCopyDir, "e2e", ".qa", "service-context", repoSlug(repo));
}

/* Case-insensitive basename match for the default contract sweep when no openapi hint is declared. */
const DEFAULT_CONTRACT_RE = /^(openapi|swagger|api-definition).*\.(ya?ml|json)$/i;
function matchesDefaultContractSweep(relPath: string): boolean {
  const base = relPath.split("/").pop() ?? relPath;
  return DEFAULT_CONTRACT_RE.test(base);
}

/*
 * Minimal glob matcher for declared openapi hints (config/apps/*.yaml `openapi:` values): "**"
 * (any depth), "*" (single path segment), "?" (single char), everything else literal. Not a
 * general-purpose glob engine — deliberately narrow to the shapes this config surface uses.
 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

/* Git's own directory holds the mirror's configuration and objects, never the service's code: nothing under it is staged. */
function insideGitDir(relPath: string): boolean {
  return relPath.split("/").includes(".git");
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export async function stageServiceContext(
  input: StageServiceContextInput,
  deps: ServiceContextStagingPort,
): Promise<StagedServiceContext> {
  const { workingCopyDir, service, sha } = input;
  const dir = serviceContextDir(workingCopyDir, service.repo);

  /*
   * Idempotent re-stage: wipe any prior run's content first so a stale file from a previous sha
   * (or a hint that has since changed) never survives into this run's snapshot.
   */
  /* mutation-scope:begin reset-staging-dir */
  if (deps.exists(dir)) deps.rm(dir, workingCopyDir);
  deps.mkdir(dir, workingCopyDir);
  /* mutation-scope:end reset-staging-dir */

  const contracts: string[] = [];
  const changed: string[] = [];
  const omitted: OmittedEntry[] = [];
  let totalBytes = 0;
  let fileCount = 0;

  const tryStageBuffer = (destRelPath: string, buf: Buffer): true | string => {
    if (fileCount >= MAX_FILES) return "max-files cap (200) exceeded";
    if (buf.byteLength > MAX_FILE_BYTES) return "file too large (> 512KB)";
    if (totalBytes + buf.byteLength > MAX_TOTAL_BYTES) return "total size cap (2MB) exceeded";
    /* mutation-scope:begin destination-path */
    const destAbs = join(dir, destRelPath);
    deps.mkdir(dirname(destAbs), workingCopyDir);
    deps.writeFile(destAbs, buf, workingCopyDir);
    /* mutation-scope:end destination-path */
    totalBytes += buf.byteLength;
    fileCount++;
    return true;
  };

  const tryStageFromMirror = (relSrcPath: string, destRelPath: string): true | string => {
    /* mutation-scope:begin source-read */
    const srcAbs = join(service.mirrorDir, relSrcPath);
    if (!deps.exists(srcAbs)) return "not found in the service mirror (deleted/renamed)";
    let buf: Buffer;
    try {
      const read = deps.readFile(srcAbs, service.mirrorDir, MAX_FILE_BYTES);
      if ("refused" in read) return `refused: ${read.refused}`;
      buf = read.bytes;
    } catch (e) {
      return `unreadable: ${e instanceof Error ? e.message : String(e)}`;
    }
    /* mutation-scope:end source-read */
    if (isBinary(buf)) return "binary file (skipped)";
    return tryStageBuffer(destRelPath, buf);
  };

  /* 1. OpenAPI/contract files — hinted glob(s) when declared, otherwise the default sweep. */
  const hints = service.openapi ? (Array.isArray(service.openapi) ? service.openapi : [service.openapi]) : undefined;
  /* mutation-scope:begin list-candidate-contracts */
  const allFiles = deps.listFiles(service.mirrorDir).filter((f) => !insideGitDir(f));
  /* mutation-scope:end list-candidate-contracts */
  const candidateContracts =
    hints && hints.length > 0
      ? (() => {
          const matchers = hints.map(globToRegExp);
          return allFiles.filter((f) => matchers.some((re) => re.test(f)));
        })()
      : allFiles.filter(matchesDefaultContractSweep);
  for (const relPath of candidateContracts) {
    const result = tryStageFromMirror(relPath, join("contracts", relPath));
    if (result === true) contracts.push(relPath);
    else omitted.push({ path: relPath, reason: result });
  }

  /*
   * 2 & 3. The commit diff + each changed file's post-change content — only when a sha is known
   * (context-mode services carry no per-run commit; contracts-only staging applies then).
   */
  if (sha) {
    assertCommitSha(sha);
    /* mutation-scope:begin patch-read */
    let patch: string | undefined;
    try {
      patch = await deps.git(["show", "--stat", "--patch", `${sha}^{commit}`], service.mirrorDir);
    } catch (e) {
      rethrowIfUntrusted(e); /* a service mirror whose git dir is not the orchestrator's is a security refusal, not an omitted file */
      omitted.push({ path: "CHANGE.patch", reason: `git show --patch failed: ${e instanceof Error ? e.message : String(e)}` });
    }
    /* Outside the try above: a write the strict calls refuse is the working copy's fault and fails the staging, never a file omitted for git's. */
    if (patch !== undefined) {
      const result = tryStageBuffer("CHANGE.patch", Buffer.from(patch, "utf8"));
      if (result !== true) omitted.push({ path: "CHANGE.patch", reason: result });
    }
    /* mutation-scope:end patch-read */

    let changedPaths: string[] = [];
    try {
      /* `^{commit}`: a sha that names a blob or a tree makes git print its content, which would be read as paths. */
      const out = await deps.git(["show", "--name-only", "--pretty=format:", `${sha}^{commit}`], service.mirrorDir);
      changedPaths = out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch (e) {
      rethrowIfUntrusted(e);
      omitted.push({ path: "changed/*", reason: `git show --name-only failed: ${e instanceof Error ? e.message : String(e)}` });
    }
    for (const relPath of changedPaths) {
      if (insideGitDir(relPath)) {
        omitted.push({ path: relPath, reason: "inside .git (never staged)" });
        continue;
      }
      const result = tryStageFromMirror(relPath, join("changed", relPath));
      if (result === true) changed.push(relPath);
      else omitted.push({ path: relPath, reason: result });
    }
  }

  const manifest: ServiceContextManifest = {
    repo: service.repo,
    ...(sha ? { sha } : {}),
    stagedAt: new Date(deps.now()).toISOString(),
    contracts,
    changed,
    omitted,
  };
  /* mutation-scope:begin manifest-write */
  const manifestPath = join(dir, "manifest.json");
  deps.writeFile(manifestPath, JSON.stringify(manifest, null, 2), workingCopyDir);
  /* mutation-scope:end manifest-write */

  return { dir, manifestPath };
}
