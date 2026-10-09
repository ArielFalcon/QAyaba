/*
 * Stages a READ-ONLY, bounded snapshot of a related microservice (OpenAPI/contract files + the
 * triggering commit's diff and post-change file content) inside the front repo working copy,
 * under e2e/.qa/service-context/<repo-slug>/. The agent session is rooted at the front copy —
 * sibling-mirror absolute paths trip opencode serve's external_directory gate and hang. Staging
 * in-root keeps every read inside the session. Path is a pure function of (workingCopyDir, repo),
 * not sha, so composition can compute it before checkout. Every fs/git side effect is injected
 * via StageDeps.
 *
 * Both sides are directories the agent can write into: the service's mirror (a repository's tree
 * can hold committed links, and the agent can plant a link, a named pipe or a file of any size in
 * any mirror) and the front's working copy the context is staged into. So the service's files are
 * listed by the one walk of the files of a repository and read through the strict, capped read
 * (spec-path-confinement): a link is never followed and a named pipe never opened, and what cannot
 * be used is omitted with a reason of the module's own. The staging directory is emptied, made and
 * written through the strict calls rooted at the working copy, so nothing is made or written
 * through a link the agent planted in it.
 */

import { dirname, join, relative, sep } from "node:path";
import { lstatSync, rmSync } from "node:fs";
import type { Git } from "../integrations/repo-mirror";
import { realGit } from "../integrations/repo-mirror";
import { rethrowIfUntrusted } from "@kernel/domain-error";
import { ConfinedPathError, ensureOwnedSpecDir, readOwnedSpecFile, writeOwnedSpecFile, type SpecRoot } from "../../qa-engine/src/shared-infrastructure/spec-path-confinement";
import { RepoReader } from "../../qa-engine/src/shared-infrastructure/repo-reader";

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

export interface StageDeps {
  git: Git;
  exists(path: string): boolean;
  /* The paths below are all below a root — the front's working copy for what is staged, the service's mirror for what is read — which the real calls anchor on: a link anywhere below it is never followed (see the header). */
  mkdir(path: string, root: string): void;  /* recursive (mkdir -p semantics) */
  rm(path: string, root: string): void;  /* recursive + force (rm -rf semantics) */
  /** All FILES (not directories) under `dir`, recursively, as POSIX-style paths relative to `dir`. */
  listFiles(dir: string): string[];
  /** The bytes of the regular file at `path` below `root`; throws ConfinedPathError for a file that is refused (a link, a named pipe, a directory, a file over the cap). */
  readFile(path: string, root: string): Buffer;
  writeFile(path: string, data: string | Buffer, root: string): void;
  now(): number;  /* epoch millis — matches the now()/deploy-gate.ts, mirror-prune.ts precedent */
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
 * rewritten-engine-factory.ts (which threads it, synchronously, into triggerService.mirrorDir /
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

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export async function stageServiceContext(
  input: StageServiceContextInput,
  deps: StageDeps = defaultStageDeps,
): Promise<StagedServiceContext> {
  const { workingCopyDir, service, sha } = input;
  const dir = serviceContextDir(workingCopyDir, service.repo);

  /*
   * Idempotent re-stage: wipe any prior run's content first so a stale file from a previous sha
   * (or a hint that has since changed) never survives into this run's snapshot.
   */
  if (deps.exists(dir)) deps.rm(dir, workingCopyDir);
  deps.mkdir(dir, workingCopyDir);

  const contracts: string[] = [];
  const changed: string[] = [];
  const omitted: OmittedEntry[] = [];
  let totalBytes = 0;
  let fileCount = 0;

  const tryStageBuffer = (destRelPath: string, buf: Buffer): true | string => {
    if (fileCount >= MAX_FILES) return "max-files cap (200) exceeded";
    if (buf.byteLength > MAX_FILE_BYTES) return "file too large (> 512KB)";
    if (totalBytes + buf.byteLength > MAX_TOTAL_BYTES) return "total size cap (2MB) exceeded";
    const destAbs = join(dir, destRelPath);
    deps.mkdir(dirname(destAbs), workingCopyDir);
    deps.writeFile(destAbs, buf, workingCopyDir);
    totalBytes += buf.byteLength;
    fileCount++;
    return true;
  };

  const tryStageFromMirror = (relSrcPath: string, destRelPath: string): true | string => {
    const srcAbs = join(service.mirrorDir, relSrcPath);
    if (!deps.exists(srcAbs)) return "not found in the service mirror (deleted/renamed)";
    let buf: Buffer;
    try {
      buf = deps.readFile(srcAbs, service.mirrorDir);
    } catch (e) {
      if (e instanceof ConfinedPathError) return `refused: ${e.reason}`;
      return `unreadable: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (isBinary(buf)) return "binary file (skipped)";
    return tryStageBuffer(destRelPath, buf);
  };

  /* 1. OpenAPI/contract files — hinted glob(s) when declared, otherwise the default sweep. */
  const hints = service.openapi ? (Array.isArray(service.openapi) ? service.openapi : [service.openapi]) : undefined;
  const allFiles = deps.listFiles(service.mirrorDir);
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
    let patch: string | undefined;
    try {
      patch = await deps.git(["show", "--stat", "--patch", sha], service.mirrorDir);
    } catch (e) {
      rethrowIfUntrusted(e); /* a service mirror whose git dir is not the orchestrator's is a security refusal, not an omitted file */
      omitted.push({ path: "CHANGE.patch", reason: `git show --patch failed: ${e instanceof Error ? e.message : String(e)}` });
    }
    /* Outside the try above: a write the strict calls refuse is the working copy's fault and fails the staging, never a file omitted for git's. */
    if (patch !== undefined) {
      const result = tryStageBuffer("CHANGE.patch", Buffer.from(patch, "utf8"));
      if (result !== true) omitted.push({ path: "CHANGE.patch", reason: result });
    }

    let changedPaths: string[] = [];
    try {
      const out = await deps.git(["show", "--name-only", "--pretty=format:", sha], service.mirrorDir);
      changedPaths = out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch (e) {
      rethrowIfUntrusted(e);
      omitted.push({ path: "changed/*", reason: `git show --name-only failed: ${e instanceof Error ? e.message : String(e)}` });
    }
    for (const relPath of changedPaths) {
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
  const manifestPath = join(dir, "manifest.json");
  deps.writeFile(manifestPath, JSON.stringify(manifest, null, 2), workingCopyDir);

  return { dir, manifestPath };
}

/*
 * Excludes VCS internals and installed deps from the default sweep's directory walk — mirrors
 * getDirectorySize's own recursive-walk precedent (mirror-prune.ts). The walk is the one walk of
 * the files of a repository (spec-path-confinement): it follows no link, opens no named pipe,
 * looks at no more than a cap of entries and visits them in the order of their names; what it
 * could not walk is said once for the service, naming no file.
 */
const SWEEP_SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git"]);

const strictRoot = (root: string): SpecRoot => ({ mirrorDir: root, specDir: root });
const below = (root: string, path: string): string => relative(root, path).split(sep).join("/");

/* Whether anything is at the path, a link to nothing included: a path that is followed is not there when it leads nowhere, so a link to nothing at the staging directory would be neither removed nor made, and would fail every later staging. */
const somethingAt = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

export const defaultStageDeps: StageDeps = {
  git: realGit,
  exists: somethingAt,
  mkdir: (path, root) => ensureOwnedSpecDir(strictRoot(root), below(root, path)),
  rm: (path, root) => {
    /* The path to what is removed must be ordinary directories of the working copy: a removal through a link the agent planted above it would remove what the link points at. What is at the path itself is removed as it is, a link as a link. */
    ensureOwnedSpecDir(strictRoot(root), below(root, dirname(path)));
    rmSync(path, { recursive: true, force: true });
  },
  listFiles: (dir) => {
    const reader = new RepoReader(dir);
    const files = reader.files(() => true, SWEEP_SKIP_DIRS);
    reader.warn(dir);
    return files;
  },
  readFile: (path, root) => {
    const rel = below(root, path);
    const read = readOwnedSpecFile(strictRoot(root), rel, MAX_FILE_BYTES);
    if ("bytes" in read) return read.bytes;
    throw new ConfinedPathError(rel, "reason" in read ? read.reason : "the file is not there");
  },
  writeFile: (path, data, root) => writeOwnedSpecFile(strictRoot(root), below(root, path), data),
  now: () => Date.now(),
};
