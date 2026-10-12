/*
 * The suite store: the accepted e2e suite of one app, kept in the orchestrator's data volume (never mounted into the agents
 * container) and put back into the working copy at the start of the next run. See shared-kernel/ports/suite-store.port.ts for why.
 *
 * Layout under `storeDir` (one directory per app):
 *   manifest.json   the entries, each with the sha256 of its content and what admitted it; replaced atomically (temporary file + rename)
 *   blobs/<sha256>  the content, addressed by its hash; unreferenced blobs are removed after every manifest swap
 *
 * One writer: the queue runs one run at a time. Everything read from or written to the suite directory is untrusted and goes
 * through spec-path-confinement.ts; the store's own directory is the orchestrator's and is read plainly, with each blob checked
 * against its hash. Git is the other source of truth: a path git tracks with other content than the one a stored file was admitted
 * over belongs to git, so a merged pull request is never overwritten by an older stored copy.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SuiteCaptureInput, SuiteCaptureResult, SuiteRestoreResult, SuiteRoot, SuiteStorePort } from "@kernel/ports/suite-store.port.ts";
import { normalizeSpecPath } from "@kernel/spec-path.ts";
import { isStockAuthSetup } from "../../../shared-infrastructure/e2e-seed/auth-setup-seed.ts";
import { hardenGitArgs } from "../../../shared-infrastructure/process-sandbox/git-hardening.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import { readOwnedSpecFile, writeOwnedSpecFile } from "../../../shared-infrastructure/spec-path-confinement.ts";
import { MAX_FILE_BYTES, assertSafeRelative, exclusionReason, looksLikeSessionState, walkTree } from "../../../shared-infrastructure/suite-tree.ts";

export const SUITE_MANIFEST_SCHEMA = 1;
const MANIFEST_FILE = "manifest.json";
const BLOBS_DIR = "blobs";
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
export const AUTH_SETUP_PATH = "auth.setup.ts";

/** What the store never takes: the context map has a store of its own, and the probe directory is scratch space of a run. */
const STORE_EXCLUDED_PATHS = [".qa/context.json", ".qa-probe"] as const;
/** Spec-named files that are the engine's own seed and no test the suite runs: stored as support, so a restore leaves the project whole. */
const SEED_SPEC_FILES: ReadonlySet<string> = new Set(["cleanup.spec.ts"]);
const SPEC_FILE = /\.spec\.[cm]?[jt]sx?$/;

export const SUITE_ENTRY_KIND = { SPEC: "spec", SUPPORT: "support", AUTH_SETUP: "auth-setup" } as const;
export type SuiteEntryKind = (typeof SUITE_ENTRY_KIND)[keyof typeof SUITE_ENTRY_KIND];

export const AUTH_STATUS = { VERIFIED: "verified", DEMOTED: "demoted" } as const;
export type AuthStatus = (typeof AUTH_STATUS)[keyof typeof AUTH_STATUS];

export interface SuiteEntryAdmission {
  runId: string;
  sha: string;
  at: string;
}

export interface SuiteEntry {
  path: string;
  sha256: string;
  bytes: number;
  kind: SuiteEntryKind;
  admittedBy: SuiteEntryAdmission;
  /** The git blob the path had when the entry was admitted, when git tracked it: the store overlays the entry only while git still has that blob. */
  gitBaseBlob?: string;
}

export interface SuiteAuthRecord {
  sha256: string;
  verifiedBy: { runId: string; at: string };
  status: AuthStatus;
  reason?: string;
}

export interface SuiteManifest {
  schema: typeof SUITE_MANIFEST_SCHEMA;
  app: string;
  repo: string;
  specRelDir: string;
  generation: number;
  entries: SuiteEntry[];
  auth?: SuiteAuthRecord;
}

/** A tracked file as git lists it: its blob id. */
export interface TrackedFile {
  oid: string;
}

export interface SuiteStoreLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
}

export const DEFAULT_SUITE_STORE_LIMITS: SuiteStoreLimits = {
  maxFileBytes: MAX_FILE_BYTES,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntries: 5_000,
};

export interface SuiteStoreDeps {
  /** `<data>/suites/<app>`. */
  storeDir: string;
  app: string;
  repo: string;
  /** The suite directory below the working copy ("e2e"). */
  specRelDir: string;
  /** The files git tracks under the suite directory at the working copy's HEAD, keyed by their path below the suite directory. */
  listTracked(mirrorDir: string, specRelDir: string): Promise<ReadonlyMap<string, TrackedFile>>;
  now(): Date;
  limits?: SuiteStoreLimits;
  warn?(message: string): void;
  /** A store the run only reads: a capture writes nothing, and a demotion only takes the login out of the working copy. For a run that must leave no cross-run state (a campaign's). */
  readOnly?: boolean;
}

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The id git gives a blob of these bytes: the hash of `blob <size>\0<bytes>`; a repository on SHA-256 object ids has 64-character ids. */
export function gitBlobOid(bytes: Uint8Array, idLength: number): string {
  return createHash(idLength === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function suiteEntryKind(path: string): SuiteEntryKind {
  if (path === AUTH_SETUP_PATH) return SUITE_ENTRY_KIND.AUTH_SETUP;
  const name = path.split("/").pop() ?? path;
  return SPEC_FILE.test(name) && !SEED_SPEC_FILES.has(path) ? SUITE_ENTRY_KIND.SPEC : SUITE_ENTRY_KIND.SUPPORT;
}

function storeExclusion(rel: string): string | undefined {
  return STORE_EXCLUDED_PATHS.some((path) => rel === path || rel.startsWith(`${path}/`)) ? "kept out of the suite store" : undefined;
}

const BLOB_ID = /^[0-9a-f]{64}$/;

/** The files `git ls-files -s -z` lists below `specRelDir` (stage 0, ordinary files), keyed by their path below it. Symbolic links and submodules are not files of the suite. */
export function parseStagedListing(stdout: string, specRelDir: string): Map<string, TrackedFile> {
  const tracked = new Map<string, TrackedFile>();
  const prefix = `${specRelDir}/`;
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) throw new Error(`git ls-files -s printed a record without a path: ${JSON.stringify(record.slice(0, 80))}`);
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (stage !== "0" || (mode !== "100644" && mode !== "100755") || oid === undefined || !path.startsWith(prefix)) continue;
    tracked.set(path.slice(prefix.length), { oid });
  }
  return tracked;
}

/** `listTracked` over git, run as every engine git call is: hardened, with a scrubbed environment. */
export function gitListTracked(runner: SandboxedBinaryRunner): SuiteStoreDeps["listTracked"] {
  return async (mirrorDir, specRelDir) => {
    const r = await runner.run({ command: "git", args: hardenGitArgs(["ls-files", "-s", "-z", "--", specRelDir], mirrorDir), cwd: mirrorDir, env: scrubEnv() });
    if (r.timedOut) throw new Error(`git ls-files timed out in ${mirrorDir}`);
    if (r.exitCode !== 0) throw new Error(`git ls-files failed (exit ${r.exitCode}) in ${mirrorDir}: ${r.stderr.trim()}`);
    return parseStagedListing(r.stdout, specRelDir);
  };
}

function emptyManifest(deps: SuiteStoreDeps): SuiteManifest {
  return { schema: SUITE_MANIFEST_SCHEMA, app: deps.app, repo: deps.repo, specRelDir: deps.specRelDir, generation: 0, entries: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(text: string): SuiteManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("the suite store's manifest is not valid JSON");
  }
  if (!isRecord(raw) || raw.schema !== SUITE_MANIFEST_SCHEMA || !Array.isArray(raw.entries) || typeof raw.generation !== "number") {
    throw new Error(`the suite store's manifest is not schema ${SUITE_MANIFEST_SCHEMA}`);
  }
  const kinds: ReadonlySet<string> = new Set(Object.values(SUITE_ENTRY_KIND));
  for (const entry of raw.entries as unknown[]) {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.sha256 !== "string" || !BLOB_ID.test(entry.sha256)
      || typeof entry.bytes !== "number" || typeof entry.kind !== "string" || !kinds.has(entry.kind) || !isRecord(entry.admittedBy)) {
      throw new Error("the suite store's manifest holds a malformed entry");
    }
    assertSafeRelative(entry.path);
  }
  return raw as unknown as SuiteManifest;
}

/** Replaces `path` with `bytes` through a temporary file in the same directory, so a reader sees the old file or the new one, never half. */
function writeAtomically(path: string, bytes: string | Uint8Array): void {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, bytes, { mode: 0o600 });
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

type Decision = { action: "admit"; entry: SuiteEntry; bytes: Buffer } | { action: "keep" } | { action: "drop" };

export class SuiteStoreAdapter implements SuiteStorePort {
  private readonly limits: SuiteStoreLimits;

  constructor(private readonly deps: SuiteStoreDeps) {
    this.limits = deps.limits ?? DEFAULT_SUITE_STORE_LIMITS;
  }

  async restore(root: SuiteRoot): Promise<SuiteRestoreResult> {
    const result: SuiteRestoreResult = { restored: 0, trackedWins: 0, overlaid: 0, authRestored: false };
    const manifest = this.load();
    if (manifest.entries.length === 0) return result;
    const tracked = await this.deps.listTracked(root.mirrorDir, this.deps.specRelDir);
    if (!existsSync(root.specDir)) mkdirSync(root.specDir, { recursive: true });
    for (const entry of manifest.entries) {
      if (entry.kind === SUITE_ENTRY_KIND.AUTH_SETUP && manifest.auth?.status !== AUTH_STATUS.VERIFIED) continue;
      const trackedFile = tracked.get(entry.path);
      if (trackedFile !== undefined && entry.gitBaseBlob !== trackedFile.oid) {
        result.trackedWins += 1;
        continue;
      }
      const bytes = this.readBlob(entry);
      if (bytes === undefined) continue;
      writeOwnedSpecFile(root, entry.path, bytes);
      if (trackedFile !== undefined) result.overlaid += 1;
      else result.restored += 1;
      if (entry.kind === SUITE_ENTRY_KIND.AUTH_SETUP) result.authRestored = true;
    }
    return result;
  }

  async fingerprint(root: SuiteRoot, specs: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const hashes = new Map<string, string>();
    for (const spec of specs) {
      const path = normalizeSpecPath(spec);
      const read = readOwnedSpecFile(root, path, this.limits.maxFileBytes);
      if ("bytes" in read) hashes.set(path, sha256Of(read.bytes));
    }
    return hashes;
  }

  async capture(input: SuiteCaptureInput): Promise<SuiteCaptureResult> {
    if (this.deps.readOnly) return { entries: this.load().entries.length, admitted: 0, dropped: 0, skipped: [] };
    const manifest = this.load();
    const tracked = await this.deps.listTracked(input.mirrorDir, this.deps.specRelDir);
    const green = new Map([...input.executedGreen].map(([path, hash]) => [normalizeSpecPath(path), hash]));
    const admittedBy: SuiteEntryAdmission = { runId: input.runId, sha: input.sha, at: this.deps.now().toISOString() };
    const stored = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    const skipped: Array<{ path: string; reason: string }> = [];
    const decisions = new Map<string, Decision>();

    for (const file of this.suiteFiles(input)) {
      const kind = suiteEntryKind(file);
      const executed = green.get(file);
      if (kind === SUITE_ENTRY_KIND.SPEC && executed === undefined) {
        decisions.set(file, { action: "keep" });
        continue;
      }
      if (kind === SUITE_ENTRY_KIND.AUTH_SETUP && input.authVerifiedSha256 === undefined) {
        decisions.set(file, { action: "keep" });
        continue;
      }
      const read = readOwnedSpecFile(input, file, this.limits.maxFileBytes);
      if ("reason" in read || "absent" in read) {
        decisions.set(file, { action: "keep" });
        skipped.push({ path: file, reason: "reason" in read ? read.reason : "the file vanished during the capture" });
        continue;
      }
      const bytes = read.bytes;
      if (looksLikeSessionState(file, bytes)) {
        decisions.set(file, { action: "drop" });
        skipped.push({ path: file, reason: "login session (storage state)" });
        continue;
      }
      const sha = sha256Of(bytes);
      if (kind === SUITE_ENTRY_KIND.SPEC && sha !== executed) {
        decisions.set(file, { action: "keep" });
        skipped.push({ path: file, reason: "changed after it ran green: these bytes never executed" });
        continue;
      }
      if (kind === SUITE_ENTRY_KIND.AUTH_SETUP && (sha !== input.authVerifiedSha256 || isStockAuthSetup(bytes.toString("utf8")))) {
        decisions.set(file, { action: "keep" });
        skipped.push({ path: file, reason: "not the login that signed in" });
        continue;
      }
      const trackedFile = tracked.get(file);
      if (trackedFile !== undefined && gitBlobOid(bytes, trackedFile.oid.length) === trackedFile.oid) {
        decisions.set(file, { action: "drop" });
        continue;
      }
      const entry: SuiteEntry = { path: file, sha256: sha, bytes: bytes.length, kind, admittedBy, ...(trackedFile ? { gitBaseBlob: trackedFile.oid } : {}) };
      decisions.set(file, { action: "admit", entry, bytes });
    }

    const next = new Map<string, SuiteEntry>();
    const fresh = new Map<string, Buffer>();
    let dropped = 0;
    let admitted = 0;
    let repaired = 0;
    for (const [path, decision] of decisions) {
      if (decision.action === "admit") {
        const before = stored.get(path);
        const unchanged = before !== undefined && before.sha256 === decision.entry.sha256 && before.gitBaseBlob === decision.entry.gitBaseBlob && before.kind === decision.entry.kind;
        next.set(path, unchanged ? before : decision.entry);
        if (!unchanged) {
          admitted += 1;
          fresh.set(decision.entry.sha256, decision.bytes);
        } else if (!this.blobIsIntact(decision.entry.sha256)) {
          /* The bytes are in hand and the stored copy is not whole: put them back. */
          repaired += 1;
          fresh.set(decision.entry.sha256, decision.bytes);
        }
      }
    }
    for (const [path, entry] of stored) {
      if (next.has(path)) continue;
      const decision = decisions.get(path);
      /* Kept only while the file is still in the working copy and git has not taken the path over with other content. */
      const trackedFile = tracked.get(path);
      const gitWins = trackedFile !== undefined && entry.gitBaseBlob !== trackedFile.oid;
      if (decision?.action === "keep" && !gitWins) next.set(path, entry);
      else dropped += 1;
    }

    const entries = [...next.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.assertWithinLimits(entries);

    const authEntry = next.get(AUTH_SETUP_PATH);
    const auth = this.nextAuth(manifest, authEntry, input);
    const changed = admitted > 0 || dropped > 0 || repaired > 0 || JSON.stringify(auth) !== JSON.stringify(manifest.auth);
    if (changed) {
      this.writeStore(this.nextManifest(manifest, entries, auth), fresh);
    }
    return { entries: entries.length, admitted, dropped, skipped };
  }

  async demoteAuth(root: SuiteRoot, reason: string): Promise<void> {
    const manifest = this.load();
    const entry = manifest.entries.find((candidate) => candidate.path === AUTH_SETUP_PATH);
    if (!this.deps.readOnly && (entry !== undefined || manifest.auth?.status === AUTH_STATUS.VERIFIED)) {
      const auth: SuiteAuthRecord = {
        sha256: manifest.auth?.sha256 ?? entry?.sha256 ?? "",
        verifiedBy: manifest.auth?.verifiedBy ?? { runId: entry?.admittedBy.runId ?? "", at: entry?.admittedBy.at ?? "" },
        status: AUTH_STATUS.DEMOTED,
        reason,
      };
      this.writeStore(this.nextManifest(manifest, manifest.entries.filter((candidate) => candidate.path !== AUTH_SETUP_PATH), auth), new Map());
    }
    this.removeLoginFromWorkingCopy(root);
  }

  private nextManifest(previous: SuiteManifest, entries: SuiteEntry[], auth: SuiteAuthRecord | undefined): SuiteManifest {
    return {
      schema: SUITE_MANIFEST_SCHEMA,
      app: this.deps.app,
      repo: this.deps.repo,
      specRelDir: this.deps.specRelDir,
      generation: previous.generation + 1,
      entries,
      ...(auth ? { auth } : {}),
    };
  }

  /**
   * Replaces the whole store with a snapshot's files: the experiment harness's warm start, so that two arms begin from the same suite.
   * The snapshot goes through the same rules a capture applies (nothing that holds a credential or a session, the stock login never
   * as the app's own); a snapshot's login is taken as verified, by the operator who declared the snapshot warm. A store whose manifest
   * cannot be read is replaced too: a seed is how it is repaired.
   */
  async seed(snapshot: ReadonlyMap<string, Buffer>, origin: { label: string }): Promise<{ entries: number; bytes: number }> {
    let previous: SuiteManifest;
    try {
      previous = this.load();
    } catch {
      previous = emptyManifest(this.deps);
    }
    const at = this.deps.now().toISOString();
    const admittedBy: SuiteEntryAdmission = { runId: `seed:${origin.label}`, sha: "seed", at };
    const entries: SuiteEntry[] = [];
    const fresh = new Map<string, Buffer>();
    for (const [path, bytes] of [...snapshot].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      assertSafeRelative(path);
      if (exclusionReason(path, false) !== undefined || storeExclusion(path) !== undefined || looksLikeSessionState(path, bytes)) continue;
      if (bytes.length > this.limits.maxFileBytes) throw new Error(`${path} is over the store's per-file limit of ${this.limits.maxFileBytes} bytes: nothing was stored`);
      const kind = suiteEntryKind(path);
      if (kind === SUITE_ENTRY_KIND.AUTH_SETUP && isStockAuthSetup(bytes.toString("utf8"))) continue;
      const sha256 = sha256Of(bytes);
      entries.push({ path, sha256, bytes: bytes.length, kind, admittedBy });
      fresh.set(sha256, bytes);
    }
    this.assertWithinLimits(entries);
    const login = entries.find((entry) => entry.kind === SUITE_ENTRY_KIND.AUTH_SETUP);
    const auth: SuiteAuthRecord | undefined = login ? { sha256: login.sha256, verifiedBy: { runId: admittedBy.runId, at }, status: AUTH_STATUS.VERIFIED } : undefined;
    this.writeStore(this.nextManifest(previous, entries, auth), fresh);
    return { entries: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
  }

  /* The login a verified run signed in with becomes the record; a demoted record stays until a login is verified again. */
  private nextAuth(manifest: SuiteManifest, authEntry: SuiteEntry | undefined, input: SuiteCaptureInput): SuiteAuthRecord | undefined {
    if (authEntry !== undefined && authEntry.admittedBy.runId === input.runId) {
      return { sha256: authEntry.sha256, verifiedBy: { runId: input.runId, at: authEntry.admittedBy.at }, status: AUTH_STATUS.VERIFIED };
    }
    if (authEntry === undefined && manifest.auth?.status === AUTH_STATUS.VERIFIED) return undefined;
    return manifest.auth;
  }

  /* Every regular file of the working copy's suite directory that may be stored, by its path below it. A link or a named pipe is never followed or admitted. */
  private suiteFiles(root: SuiteRoot): string[] {
    if (!existsSync(root.specDir)) return [];
    const entries = walkTree(root.specDir, (entry) => exclusionReason(entry.rel, true) === undefined && storeExclusion(entry.rel) === undefined);
    return entries
      .filter((entry) => entry.kind === "file" && exclusionReason(entry.rel, false) === undefined && storeExclusion(entry.rel) === undefined)
      .map((entry) => entry.rel);
  }

  private assertWithinLimits(entries: readonly SuiteEntry[]): void {
    const total = [...new Map(entries.map((entry) => [entry.sha256, entry.bytes])).values()].reduce((sum, bytes) => sum + bytes, 0);
    if (entries.length > this.limits.maxEntries) throw new Error(`the suite would hold ${entries.length} files, over the store's limit of ${this.limits.maxEntries}: nothing was stored`);
    if (total > this.limits.maxTotalBytes) throw new Error(`the suite would take ${total} bytes, over the store's limit of ${this.limits.maxTotalBytes}: nothing was stored`);
  }

  private load(): SuiteManifest {
    const path = join(this.deps.storeDir, MANIFEST_FILE);
    let stats;
    try {
      stats = lstatSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyManifest(this.deps);
      throw err;
    }
    if (!stats.isFile() || stats.size > MAX_MANIFEST_BYTES) throw new Error(`the suite store's manifest ${path} is not an ordinary file within ${MAX_MANIFEST_BYTES} bytes`);
    return parseManifest(readFileSync(path, "utf8"));
  }

  private readBlob(entry: SuiteEntry): Buffer | undefined {
    const path = join(this.deps.storeDir, BLOBS_DIR, entry.sha256);
    try {
      const bytes = readFileSync(path);
      if (sha256Of(bytes) === entry.sha256) return bytes;
      (this.deps.warn ?? console.error)(`[suite-store] ${entry.path}: the stored copy no longer matches its hash; it is left out and dropped at the next capture`);
    } catch (err) {
      (this.deps.warn ?? console.error)(`[suite-store] ${entry.path}: the stored copy cannot be read (${err instanceof Error ? err.message : String(err)}); it is left out and dropped at the next capture`);
    }
    return undefined;
  }

  /* Whether the blob of this hash is in the store and still hashes to its name. */
  private blobIsIntact(sha: string): boolean {
    try {
      return sha256Of(readFileSync(join(this.deps.storeDir, BLOBS_DIR, sha))) === sha;
    } catch {
      return false;
    }
  }

  /* Blobs first, then the manifest swap, then the removal of what nothing references: a crash in between leaves the previous manifest whole. */
  private writeStore(manifest: SuiteManifest, fresh: ReadonlyMap<string, Buffer>): void {
    const blobs = join(this.deps.storeDir, BLOBS_DIR);
    mkdirSync(blobs, { recursive: true, mode: 0o700 });
    for (const [sha, bytes] of fresh) {
      const target = join(blobs, sha);
      if (!this.blobIsIntact(sha)) writeAtomically(target, bytes);
    }
    writeAtomically(join(this.deps.storeDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    const referenced = new Set(manifest.entries.map((entry) => entry.sha256));
    for (const name of readdirSync(blobs)) {
      if (!referenced.has(name)) rmSync(join(blobs, name), { force: true });
    }
  }

  /* The stored login is no longer wanted in the working copy: the project setup then seeds the stock one. Only an ordinary file is removed, and only its name goes. */
  private removeLoginFromWorkingCopy(root: SuiteRoot): void {
    const path = join(root.specDir, AUTH_SETUP_PATH);
    let stats;
    try {
      stats = lstatSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (stats.isDirectory()) throw new Error(`${path} is a directory: it cannot be replaced by the stock login`);
    unlinkSync(path);
  }
}

/** Removes an app's whole store (a purge of the app). A store that is not there is a store removed. */
export function deleteSuiteStoreDir(storeDir: string): void {
  if (!existsSync(storeDir)) return;
  if (!statSync(storeDir).isDirectory()) throw new Error(`${storeDir} is not a directory`);
  rmSync(storeDir, { recursive: true, force: true });
}
