/*
 * DelegationWorkspacePort over the filesystem. A workspace is a plain directory under the delegations root, which lies on the
 * shared mirrors volume so that the sidekick's runtime can open a session in it, and it holds a COPY of what the run may read,
 * made file by file through the confined reader: a link in the working copy, a named pipe, an installed package, a git directory, a
 * login session, a credential file or a file past the size of a source is not copied. There is no git in it, so there is nothing
 * to harden and nothing a crash leaves behind in the working copy's git directory; a sweep that removes the root clears every
 * leftover.
 *
 * What comes back is decided here and by one rule. The files the brief named as writable are read from the workspace strictly
 * (no link on the way, a regular file, a size cap) and written into the working copy strictly; everything else the sidekick
 * changed is only listed. The workspace is the agent's to write while it runs, so every read of it after that is a read of
 * untrusted bytes and goes through spec-path-confinement.
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { removeTreeBounded } from "../../../shared-infrastructure/bounded-tree-removal.ts";
import { PROBE_REL_DIR } from "@contexts/test-execution/domain/run-spec-capability.ts";
import {
  MAX_SPEC_SOURCE_BYTES,
  readConfinedSpecBytes,
  readOwnedSpecFile,
  walkRepoFiles,
  writeOwnedSpecFile,
  type SpecRoot,
} from "../../../shared-infrastructure/spec-path-confinement.ts";
import {
  WORKSPACE_CHANGE,
  type DelegationCollection,
  type DelegationWorkspace,
  type DelegationWorkspacePort,
  type DelegationWorkspaceRequest,
  type RefusedCopy,
  type WorkspaceChange,
} from "../application/ports/delegation-workspace.port.ts";

export interface WorkspaceLimits {
  /* The most files the read view holds. */
  maxFiles: number;
  /* The most bytes the read view holds in all. */
  maxTotalBytes: number;
  /* The most proposals one collection lists; the total is counted beside them. */
  maxProposals: number;
}

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = { maxFiles: 6_000, maxTotalBytes: 96 * 1024 * 1024, maxProposals: 50 };

/* Directories nothing is copied from: dependencies, build output, the git directory, a run's own outputs and the sessions the orchestrator keeps. */
const NOT_COPIED_DIRS: ReadonlySet<string> = new Set([
  ".git", "node_modules", ".auth", "test-results", "playwright-report", ".qa-probe",
  "dist", "build", "out", ".next", ".nuxt", "coverage", "target", ".gradle", ".venv", "__pycache__", ".idea", ".vscode",
]);

/* Files nothing is copied from: environment files (the example one is source), sessions, certificates and keys. */
function copiable(name: string): boolean {
  if (name === ".env.example") return true;
  if (/^\.env(\..*)?$/.test(name)) return false;
  if (/^storageState.*\.json$/i.test(name)) return false;
  if (/^(client\.p12|cert\.pass)$/i.test(name)) return false;
  if (/\.(pem|key|p12|pfx|jks)$/i.test(name)) return false;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(name)) return false;
  return true;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export interface FsDelegationWorkspaceDeps {
  /* The absolute directory the workspaces are made under. */
  root: string;
  limits?: Partial<WorkspaceLimits>;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class FsDelegationWorkspaceAdapter implements DelegationWorkspacePort {
  private readonly limits: WorkspaceLimits;
  /* What each workspace held when it was made, by file, so that a change can be told from a file that was always there. */
  private readonly baselines = new Map<string, Map<string, string>>();

  constructor(private readonly deps: FsDelegationWorkspaceDeps) {
    this.limits = { ...DEFAULT_WORKSPACE_LIMITS, ...deps.limits };
  }

  async create(request: DelegationWorkspaceRequest): Promise<DelegationWorkspace> {
    if (!SAFE_ID.test(request.runId)) throw new Error(`run id ${JSON.stringify(request.runId)} cannot name a delegation workspace`);
    if (!SAFE_ID.test(request.delegationId)) throw new Error(`delegation id ${JSON.stringify(request.delegationId)} cannot name a delegation workspace`);
    const dir = join(this.deps.root, request.runId, request.delegationId);
    mkdirSync(dirname(dir), { recursive: true });
    removeTreeBounded(dir);
    mkdirSync(dir);

    const source: SpecRoot = { mirrorDir: request.mirrorDir, specDir: request.mirrorDir };
    const walk = walkRepoFiles(request.mirrorDir, (name) => copiable(name), NOT_COPIED_DIRS);
    const baseline = new Map<string, string>();
    let bytesCopied = 0;
    let cut = walk.cut;
    for (const rel of walk.files) {
      if (baseline.size >= this.limits.maxFiles || bytesCopied >= this.limits.maxTotalBytes) {
        cut = true;
        break;
      }
      let bytes: Buffer;
      try {
        bytes = readConfinedSpecBytes(source, rel, MAX_SPEC_SOURCE_BYTES);
      } catch {
        /* A file that is not a plain source of a readable size is not part of the view. */
        continue;
      }
      if (bytesCopied + bytes.length > this.limits.maxTotalBytes) {
        cut = true;
        break;
      }
      const target = join(dir, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { mode: 0o644 });
      bytesCopied += bytes.length;
      baseline.set(rel, sha256(bytes));
    }
    mkdirSync(join(dir, request.specRelDir), { recursive: true });
    this.baselines.set(dir, baseline);
    return { dir, specDir: join(dir, request.specRelDir), specRelDir: request.specRelDir, files: baseline.size, cut };
  }

  async stage(workspace: DelegationWorkspace, request: DelegationWorkspaceRequest, path: string, probePath: string): Promise<boolean> {
    const normalized = path.replaceAll("\\", "/");
    if (!request.writablePaths.some((writable) => writable.replaceAll("\\", "/") === normalized)) {
      throw new Error(`${path} is not among the files this delegation may write`);
    }
    const target = probePath.replaceAll("\\", "/");
    if (!target.startsWith(`${PROBE_REL_DIR}/`) || target.split("/").includes("..")) {
      throw new Error(`${probePath} is not in the probe directory ${PROBE_REL_DIR}`);
    }
    const copied = this.copyBack(workspace, request, normalized, target);
    if ("reason" in copied) throw new Error(`${path} cannot be copied from the workspace: ${copied.reason}`);
    return copied.copied;
  }

  async collect(workspace: DelegationWorkspace, request: DelegationWorkspaceRequest): Promise<DelegationCollection> {
    const copied: string[] = [];
    const refused: RefusedCopy[] = [];
    const writable = new Set<string>();
    for (const path of request.writablePaths) {
      const normalized = path.replaceAll("\\", "/");
      writable.add(normalized);
      const result = this.copyBack(workspace, request, normalized, undefined, true);
      if ("reason" in result) refused.push({ path: normalized, reason: result.reason });
      else if (result.copied) copied.push(normalized);
    }
    const proposals = this.changesOf(workspace, writable);
    return {
      copied,
      refused,
      proposals: proposals.slice(0, this.limits.maxProposals),
      proposalsTotal: proposals.length,
    };
  }

  async dispose(workspace: DelegationWorkspace): Promise<void> {
    this.baselines.delete(workspace.dir);
    try {
      removeTreeBounded(workspace.dir);
    } catch (err) {
      console.error(`[qa] removing the delegation workspace ${workspace.dir} failed (the next sweep removes it): ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    try {
      rmdirSync(dirname(workspace.dir));
    } catch {
      /* not empty: another delegation of the run is still there, or it is already gone */
    }
  }

  async sweepAll(): Promise<number> {
    let stats;
    try {
      stats = lstatSync(this.deps.root);
    } catch {
      return 0;
    }
    /* A root that is a link is not followed: it is not the directory this adapter made. */
    if (!stats.isDirectory()) return 0;
    let removed = 0;
    for (const runFolder of readdirSync(this.deps.root)) {
      const path = join(this.deps.root, runFolder);
      const inside = lstatSync(path, { throwIfNoEntry: false });
      const workspaces = inside?.isDirectory() ? readdirSync(path).length : 0;
      try {
        removeTreeBounded(path);
        removed += Math.max(workspaces, 1);
      } catch (err) {
        console.error(`[qa] sweeping ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.baselines.clear();
    return removed;
  }

  /* One writable file from the workspace into the working copy, strictly on both sides: to its own place, or to `to` below the spec directory. With `onlyChanged`, a file whose bytes are those the workspace was made with is left alone and reported as not copied, since the sidekick delivered nothing for it. */
  private copyBack(workspace: DelegationWorkspace, request: DelegationWorkspaceRequest, path: string, to?: string, onlyChanged = false): { copied: boolean } | { reason: string } {
    const prefix = `${request.specRelDir.replace(/\/+$/, "")}/`;
    if (!path.startsWith(prefix) || path.split("/").includes("..")) return { reason: `the path is not inside the spec directory ${request.specRelDir}` };
    const rel = path.slice(prefix.length);
    if (rel === "" || rel.endsWith("/")) return { reason: "the path names no file" };
    const from: SpecRoot = { mirrorDir: workspace.dir, specDir: workspace.specDir };
    const read = readOwnedSpecFile(from, rel, MAX_SPEC_SOURCE_BYTES);
    if ("absent" in read) return { copied: false };
    if ("reason" in read) return { reason: read.reason };
    if (onlyChanged && this.baselines.get(workspace.dir)?.get(path) === sha256(read.bytes)) return { copied: false };
    try {
      writeOwnedSpecFile({ mirrorDir: request.mirrorDir, specDir: request.specDir }, to ?? rel, read.bytes);
    } catch (err) {
      return { reason: `it could not be written into the working copy: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { copied: true };
  }

  /* What differs between the workspace now and the view it was made with, outside the files that went back. */
  private changesOf(workspace: DelegationWorkspace, writable: ReadonlySet<string>): WorkspaceChange[] {
    const baseline = this.baselines.get(workspace.dir) ?? new Map<string, string>();
    const root: SpecRoot = { mirrorDir: workspace.dir, specDir: workspace.dir };
    const walk = walkRepoFiles(workspace.dir, (name) => copiable(name), NOT_COPIED_DIRS, { maxEntries: 100_000, maxFiles: this.limits.maxFiles * 2 });
    const changes: WorkspaceChange[] = [];
    const present = new Set<string>();
    for (const rel of walk.files) {
      present.add(rel);
      if (writable.has(rel)) continue;
      const before = baseline.get(rel);
      let bytes: Buffer | undefined;
      try {
        bytes = readConfinedSpecBytes(root, rel, MAX_SPEC_SOURCE_BYTES);
      } catch {
        bytes = undefined;
      }
      const size = bytes?.length ?? sizeOf(join(workspace.dir, rel));
      if (before === undefined) changes.push({ path: rel, kind: WORKSPACE_CHANGE.ADDED, bytes: size });
      else if (bytes === undefined || sha256(bytes) !== before) changes.push({ path: rel, kind: WORKSPACE_CHANGE.MODIFIED, bytes: size });
    }
    for (const rel of baseline.keys()) {
      if (!present.has(rel) && !writable.has(rel)) changes.push({ path: rel, kind: WORKSPACE_CHANGE.DELETED, bytes: 0 });
    }
    return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}

function sizeOf(path: string): number {
  try {
    return lstatSync(path).size;
  } catch {
    return 0;
  }
}
