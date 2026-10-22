/*
 * What an arm left in the suite directory, for the campaign (scripts/campaign.ts). EXPERIMENT ONLY.
 *
 * Both arms start from the same warm snapshot of `e2e/` (scripts/warm-suite.ts); what each one DELIVERED is the
 * difference between the directory it worked in and that snapshot. The directory is the agent's, so it is walked
 * without following a link and read only through the confined reader, and what a snapshot leaves out (install and
 * run output, the login session, credentials) never enters the delta either.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readOwnedSpecFile } from "../qa-engine/src/shared-infrastructure/spec-path-confinement.ts";
import type { SnapshotManifest } from "./warm-suite.ts";
import { MAX_FILE_BYTES, exclusionReason, looksLikeSessionState, walkTree } from "../qa-engine/src/shared-infrastructure/suite-tree.ts";

export interface DeltaFile {
  /** Relative to the suite directory, "/"-separated. */
  path: string;
  bytes: Buffer;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface SuiteDelta {
  /** Added, or changed since the snapshot. */
  files: DeltaFile[];
  /** In the snapshot, gone now. */
  removed: string[];
  /** Files that could not be taken (a link, an oversized file, a read the confined reader refused). */
  skipped: SkippedFile[];
}

export interface SuiteRoot {
  /** The working copy that holds the suite directory. */
  mirrorDir: string;
  e2eDir: string;
}

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Files of the suite directory that differ from the snapshot, minus `ignore` (paths the caller's own harness owns). */
export function suiteDelta(root: SuiteRoot, manifest: SnapshotManifest, ignore: ReadonlySet<string> = new Set()): SuiteDelta {
  const recorded = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  const files: DeltaFile[] = [];
  const skipped: SkippedFile[] = [];
  const seen = new Set<string>();
  const entries = walkTree(root.e2eDir, (entry) => exclusionReason(entry.rel, true) === undefined);
  for (const entry of entries) {
    if (entry.kind === "dir") continue;
    if (exclusionReason(entry.rel, false) !== undefined || ignore.has(entry.rel)) continue;
    if (entry.kind !== "file") {
      skipped.push({ path: entry.rel, reason: entry.kind === "link" ? "symbolic link (never followed)" : "not a regular file" });
      continue;
    }
    seen.add(entry.rel);
    const read = readOwnedSpecFile({ mirrorDir: root.mirrorDir, specDir: root.e2eDir }, entry.rel, MAX_FILE_BYTES);
    if (!("bytes" in read)) {
      skipped.push({ path: entry.rel, reason: "reason" in read ? read.reason : "the file is not there" });
      continue;
    }
    if (looksLikeSessionState(entry.rel, read.bytes)) continue;
    if (recorded.get(entry.rel) !== sha256Of(read.bytes)) files.push({ path: entry.rel, bytes: read.bytes });
  }
  const removed = manifest.files.map((f) => f.path).filter((p) => !seen.has(p) && !ignore.has(p)).sort();
  return { files, removed, skipped };
}

/** The spec files of a delta: `*.spec.ts`, without the data-cleanup spec the pipeline treats as infrastructure. */
export function specsOf(files: readonly DeltaFile[]): string[] {
  return files
    .map((f) => f.path)
    .filter((p) => p.endsWith(".spec.ts") && (p.split("/").pop() ?? p) !== "cleanup.spec.ts")
    .sort();
}

/** Writes the files under `dest`, each at its relative path. The paths come from a walk of the suite, but a path that is not plain relative is refused all the same. */
export function saveSuiteFiles(dest: string, files: readonly DeltaFile[]): void {
  for (const f of files) {
    if (f.path === "" || f.path.startsWith("/") || f.path.includes("\\") || f.path.split("/").some((s) => s === "" || s === "." || s === "..")) {
      throw new Error(`unsafe path ${JSON.stringify(f.path)}: not saved`);
    }
    const target = join(dest, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.bytes);
  }
  mkdirSync(dest, { recursive: true });
}
