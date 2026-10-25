/*
 * Warm start for the pipeline-vs-plain-agent experiment. EXPERIMENT ONLY: nothing in the service calls this.
 *
 * A watched app's suite (`e2e/`) starts every run from the stock seed, so every run first has to author the
 * app's login. To compare the two arms on what they do for the CHANGE, both start each case from the same
 * snapshot of `e2e/` that already holds a working `auth.setup.ts`, and no case sees the specs a previous one left.
 *
 *   npm run warm-suite -- snapshot --app <app> --label <l>
 *   npm run warm-suite -- restore  --app <app> --label <l> [--dry-run]
 *   npm run warm-suite -- verify   --app <app> --label <l>
 *   npm run warm-suite -- seed-store --app <app> --label <l>
 *
 * `snapshot` copies the app's primary mirror `e2e/` to <mirrors>/.warm/<app>/<label>/e2e and records a manifest
 * (every file with its sha256, and what was left out and why). It leaves out install and run output
 * (node_modules, test-results, playwright-report, ...), the login session (`.auth/`, any storage-state file) and
 * anything that holds credentials (.env files, client certificates, keys). The mirrors volume is mounted into the
 * agents container, so nothing in a snapshot may be a secret. `restore` makes the mirror's `e2e/` equal to a
 * snapshot, node_modules kept so no dependency install is repeated. Both refuse unless the service's queue is
 * idle: the mirror belongs to the run that is using it. `verify` says whether the snapshot's login is warm.
 * `seed-store` loads a snapshot into the app's suite store (data/suites/<app>/, the durable copy a pipeline run restores
 * after its checkout), replacing whatever the store held, so the pipeline's next run starts from the same suite as the
 * plain agent's throwaway copy. It is how a campaign gives the pipeline arm its warm start; restoring the mirror does
 * nothing for a run, whose checkout wipes the untracked suite.
 * The baseline arm applies the same snapshot to its throwaway copy (`baseline-agent --warm <label>`).
 *
 * Everything under `e2e/` is untrusted (the agent writes there): it is walked without following a link, read
 * and written only through the confined helpers of spec-path-confinement.ts, and a link, a named pipe or an
 * oversized file is never followed, waited on or silently dropped from the equality `restore` promises.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isStockAuthSetup } from "../qa-engine/src/shared-infrastructure/e2e-seed/auth-setup-seed.ts";
import { readOwnedSpecFile, writeOwnedSpecFile } from "../qa-engine/src/shared-infrastructure/spec-path-confinement.ts";
import { MAX_FILE_BYTES, NODE_MODULES, assertRealDirectory, assertSafeRelative, exclusionReason, looksLikeSessionState, readStrict, walkTree } from "../qa-engine/src/shared-infrastructure/suite-tree.ts";
import { WARM_SNAPSHOTS_DIR } from "../src/paths.ts";
import { DEFAULT_SUITE_DIR } from "./probe-metrics.ts";
import { assertFileName } from "./probe-report.ts";

/* ── what a snapshot is ────────────────────────────────────────────────────────────── */

export const SNAPSHOT_SCHEMA = 1;
export const MANIFEST_FILE = "manifest.json";
/** The folder of a snapshot that holds the suite's files, beside its manifest. */
export const SNAPSHOT_SUITE_DIR = "e2e";
export const AUTH_SETUP_FILE = "auth.setup.ts";
/** The first-line marker of the stock login seed (config/e2e/auth.setup.ts). */
export const STOCK_SEED_MARKER = "qa-auth-setup-seed";
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ExcludedPath {
  path: string;
  reason: string;
}

export interface SnapshotManifest {
  schema: typeof SNAPSHOT_SCHEMA;
  app: string;
  repo: string;
  label: string;
  createdAt: string;
  files: ManifestFile[];
  excluded: ExcludedPath[];
}

export interface LoadedSnapshot {
  label: string;
  dir: string;
  manifest: SnapshotManifest;
  /** Every manifest file's bytes, each checked against its recorded sha256. */
  files: ReadonlyMap<string, Buffer>;
}

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** <mirrors>/.warm/<app>/<label>. */
export function warmSnapshotDir(warmRoot: string, app: string, label: string): string {
  assertFileName(app, "app");
  assertFileName(label, "label");
  return join(warmRoot, app, label);
}

/* ── snapshot ──────────────────────────────────────────────────────────────────────── */

export interface SnapshotInput {
  /** The mirror's working copy; the suite directory must lie inside it. */
  mirrorDir: string;
  e2eDir: string;
  /** Where the snapshot ends up; it must not exist. */
  labelDir: string;
  app: string;
  repo: string;
  label: string;
  now: Date;
}

/** Copies the suite to `labelDir` and writes its manifest. A snapshot is built beside its final name and renamed into place, so a failed one leaves nothing under the label. */
export function createSnapshot(input: SnapshotInput): SnapshotManifest {
  if (existsSync(input.labelDir)) throw new Error(`${input.labelDir} already exists: a label names one snapshot, pick another or remove the directory`);
  assertRealDirectory(input.e2eDir, "the suite directory");

  const source = { mirrorDir: input.mirrorDir, specDir: input.e2eDir };
  const files: ManifestFile[] = [];
  const excluded: ExcludedPath[] = [];
  const contents = new Map<string, Buffer>();

  const entries = walkTree(input.e2eDir, (entry) => {
    const reason = exclusionReason(entry.rel, true);
    if (reason !== undefined) excluded.push({ path: entry.rel, reason });
    return reason === undefined;
  });
  for (const entry of entries) {
    if (entry.kind === "dir") continue;
    if (entry.kind !== "file") {
      excluded.push({ path: entry.rel, reason: entry.kind === "link" ? "symbolic link (never followed)" : "not a regular file" });
      continue;
    }
    const reason = exclusionReason(entry.rel, false);
    if (reason !== undefined) {
      excluded.push({ path: entry.rel, reason });
      continue;
    }
    const bytes = readStrict(source, entry.rel, MAX_FILE_BYTES);
    if (looksLikeSessionState(entry.rel, bytes)) {
      excluded.push({ path: entry.rel, reason: "login session (storage state)" });
      continue;
    }
    contents.set(entry.rel, bytes);
    files.push({ path: entry.rel, sha256: sha256Of(bytes), bytes: bytes.length });
  }

  const manifest: SnapshotManifest = {
    schema: SNAPSHOT_SCHEMA,
    app: input.app,
    repo: input.repo,
    label: input.label,
    createdAt: input.now.toISOString(),
    files,
    excluded: excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };

  const partial = `${input.labelDir}.partial-${process.pid}`;
  rmSync(partial, { recursive: true, force: true });
  try {
    mkdirSync(join(partial, SNAPSHOT_SUITE_DIR), { recursive: true });
    const target = { mirrorDir: partial, specDir: join(partial, SNAPSHOT_SUITE_DIR) };
    for (const [path, bytes] of contents) writeOwnedSpecFile(target, path, bytes);
    writeOwnedSpecFile({ mirrorDir: partial, specDir: partial }, MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
    mkdirSync(dirname(input.labelDir), { recursive: true });
    renameSync(partial, input.labelDir);
  } catch (err) {
    rmSync(partial, { recursive: true, force: true });
    throw err;
  }
  return manifest;
}

/* ── loading and verifying ─────────────────────────────────────────────────────────── */

function parseManifest(text: string): SnapshotManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("the snapshot's manifest is not valid JSON");
  }
  const m = raw as Partial<SnapshotManifest> | null;
  if (!m || m.schema !== SNAPSHOT_SCHEMA || typeof m.app !== "string" || typeof m.label !== "string" || !Array.isArray(m.files) || !Array.isArray(m.excluded)) {
    throw new Error(`the snapshot's manifest is not schema ${SNAPSHOT_SCHEMA}`);
  }
  for (const f of m.files) {
    if (!f || typeof f.path !== "string" || typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error("the snapshot's manifest holds a malformed file entry");
    assertSafeRelative(f.path);
  }
  return m as SnapshotManifest;
}

/** Reads a snapshot whole and checks every file against the sha256 its manifest recorded; a missing or altered file is an error. */
export function loadSnapshot(labelDir: string, label: string): LoadedSnapshot {
  if (!existsSync(labelDir)) throw new Error(`there is no snapshot '${label}' at ${labelDir}: take one with 'warm-suite snapshot'`);
  const manifest = parseManifest(readStrict({ mirrorDir: labelDir, specDir: labelDir }, MANIFEST_FILE, MAX_MANIFEST_BYTES).toString("utf8"));
  const suite = { mirrorDir: labelDir, specDir: join(labelDir, SNAPSHOT_SUITE_DIR) };
  const files = new Map<string, Buffer>();
  for (const f of manifest.files) {
    const bytes = readStrict(suite, f.path, MAX_FILE_BYTES);
    if (sha256Of(bytes) !== f.sha256) throw new Error(`${f.path}: the snapshot's copy no longer matches its manifest (sha256 differs): the snapshot is corrupt`);
    files.set(f.path, bytes);
  }
  return { label, dir: labelDir, manifest, files };
}

export interface WarmStatus {
  /** `auth.setup.ts` is in the snapshot. */
  present: boolean;
  /** It still carries the stock seed's first-line marker. */
  carriesMarker: boolean;
  /** It is byte-for-byte a shipped seed revision, which the engine replaces on setup. */
  stockSeed: boolean;
  /** A login was written for the app: there is a file and it no longer carries the marker. */
  warm: boolean;
  note: string;
}

export function warmStatus(snapshot: LoadedSnapshot): WarmStatus {
  const bytes = snapshot.files.get(AUTH_SETUP_FILE);
  if (bytes === undefined) return { present: false, carriesMarker: false, stockSeed: false, warm: false, note: `the snapshot has no ${AUTH_SETUP_FILE}: every run would start from the stock seed` };
  const text = bytes.toString("utf8");
  const carriesMarker = text.includes(STOCK_SEED_MARKER);
  const stockSeed = isStockAuthSetup(text);
  if (!carriesMarker) return { present: true, carriesMarker, stockSeed, warm: true, note: `${AUTH_SETUP_FILE} was rewritten for the app (no ${STOCK_SEED_MARKER} marker)` };
  const note = stockSeed
    ? `${AUTH_SETUP_FILE} is still the stock login seed: take the snapshot after the app's login has been authored`
    : `${AUTH_SETUP_FILE} carries the ${STOCK_SEED_MARKER} marker but is not a shipped seed revision: if the login was rewritten for the app, remove the marker line, else it is an older seed`;
  return { present: true, carriesMarker, stockSeed, warm: false, note };
}

/* ── restore ───────────────────────────────────────────────────────────────────────── */

export interface RestoreSummary {
  /** In the snapshot, not in the target. */
  added: string[];
  /** In both, with other content. */
  changed: string[];
  /** In the target, not in the snapshot; a directory ends in "/". */
  removed: string[];
  unchanged: number;
  /** An ordinary node_modules was there and was left alone. */
  keptNodeModules: boolean;
}

export interface RestoreTarget {
  /** The working copy that holds the suite directory. */
  mirrorDir: string;
  e2eDir: string;
}

function planRestore(snapshot: LoadedSnapshot, target: RestoreTarget, present: boolean): RestoreSummary {
  const expected = new Map(snapshot.manifest.files.map((f) => [f.path, f.sha256]));
  const expectedDirs = new Set<string>();
  for (const path of expected.keys()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) expectedDirs.add(parts.slice(0, i).join("/"));
  }
  const plan: RestoreSummary = { added: [], changed: [], removed: [], unchanged: 0, keptNodeModules: false };
  const seen = new Set<string>();
  const root = { mirrorDir: target.mirrorDir, specDir: target.e2eDir };

  const entries = present
    ? walkTree(target.e2eDir, (entry) => {
        if (entry.rel === NODE_MODULES) {
          plan.keptNodeModules = true;
          return false;
        }
        if (expectedDirs.has(entry.rel)) return true;
        plan.removed.push(`${entry.rel}/`);
        return false;
      })
    : [];
  for (const entry of entries) {
    if (entry.kind === "dir") continue;
    const want = entry.kind === "file" ? expected.get(entry.rel) : undefined;
    if (want === undefined) {
      plan.removed.push(entry.rel);
      continue;
    }
    seen.add(entry.rel);
    /* A file the strict read refuses, or one over the cap, is not the snapshot's: it is written again. */
    const read = readOwnedSpecFile(root, entry.rel, MAX_FILE_BYTES);
    if ("bytes" in read && sha256Of(read.bytes) === want) plan.unchanged += 1;
    else plan.changed.push(entry.rel);
  }
  for (const path of expected.keys()) if (!seen.has(path)) plan.added.push(path);
  plan.removed.sort();
  plan.added.sort();
  plan.changed.sort();
  return plan;
}

/**
 * Makes the target suite directory equal to the snapshot: files it lacks are written, files that differ are replaced, and every other
 * entry (extra specs and directories, `.qa` state, a login session, a link, run output) is removed without being followed. Only an
 * ordinary `node_modules` at the top is kept. The snapshot is verified before anything changes, and the result is compared once more
 * afterwards. With `dryRun` it only says what it would do.
 */
export function restoreSuite(snapshot: LoadedSnapshot, target: RestoreTarget, opts: { dryRun?: boolean } = {}): RestoreSummary {
  const present = existsSync(target.e2eDir) || isLink(target.e2eDir);
  if (present) assertRealDirectory(target.e2eDir, "the suite directory");
  const plan = planRestore(snapshot, target, present);
  if (opts.dryRun) return plan;

  if (!present) mkdirSync(target.e2eDir, { recursive: true });
  for (const rel of plan.removed) rmSync(join(target.e2eDir, rel), { recursive: true, force: true });
  const root = { mirrorDir: target.mirrorDir, specDir: target.e2eDir };
  for (const rel of [...plan.added, ...plan.changed]) writeOwnedSpecFile(root, rel, snapshot.files.get(rel)!);

  const left = planRestore(snapshot, target, true);
  if (left.added.length + left.changed.length + left.removed.length > 0) {
    throw new Error(`the suite directory still differs from the snapshot after the restore (${[...left.added, ...left.changed, ...left.removed].slice(0, 5).join(", ")})`);
  }
  return plan;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The specs of `touched` that are not simply the snapshot's own: a spec whose content still matches the manifest was there at the start of
 * the case, so it is not something the agent wrote. A spec whose content cannot be read (`hashOf` returns null) stays in.
 */
export function specsTouchedSinceSnapshot(touched: readonly string[], manifest: SnapshotManifest, hashOf: (spec: string) => string | null): string[] {
  const recorded = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  return touched.filter((spec) => {
    const was = recorded.get(spec);
    return was === undefined || hashOf(spec) !== was;
  });
}

/* ── command line ──────────────────────────────────────────────────────────────────── */

const SUBCOMMANDS = ["snapshot", "restore", "verify", "seed-store"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export interface WarmDeps {
  /** Throws when the service's queue is not idle (nothing running, nothing pending). */
  assertQueueIdle(): Promise<void>;
  /** <mirrors>/.warm */
  warmRoot(): string;
  /** The app's primary repo, its mirror's working copy and the suite directory in it. */
  primaryMirror(app: string): { repo: string; mirrorDir: string; e2eDir: string };
  now(): Date;
  out(line: string): void;
  /** Replaces the app's suite store with these files (relative paths, as the snapshot holds them); `label` names the snapshot they came from. */
  seedStore(app: string, files: ReadonlyMap<string, Buffer>, label: string): Promise<{ entries: number; bytes: number }>;
}

type Parsed = { ok: true; command: Subcommand; app: string; label: string; dryRun: boolean } | { ok: false; problem: string };

export function parseArguments(argv: readonly string[]): Parsed {
  const command = argv[0];
  if (!SUBCOMMANDS.includes(command as Subcommand)) return { ok: false, problem: `error: the first argument is one of ${SUBCOMMANDS.join(", ")}` };
  const values: Record<string, string> = {};
  let dryRun = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--app" || a === "--label") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { ok: false, problem: `error: ${a} needs a value` };
      values[a] = v;
    } else if (a === "--dry-run" && command === "restore") dryRun = true;
    else return { ok: false, problem: `error: unknown argument ${a}` };
  }
  for (const required of ["--app", "--label"]) if (!values[required]) return { ok: false, problem: `error: ${required} is required` };
  try {
    assertFileName(values["--app"]!, "app");
    assertFileName(values["--label"]!, "label");
  } catch (err) {
    return { ok: false, problem: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, command: command as Subcommand, app: values["--app"]!, label: values["--label"]!, dryRun };
}

const USAGE = [
  "usage: npm run warm-suite -- snapshot --app <app> --label <l>",
  "       npm run warm-suite -- restore  --app <app> --label <l> [--dry-run]",
  "       npm run warm-suite -- verify   --app <app> --label <l>",
  "       npm run warm-suite -- seed-store --app <app> --label <l>",
  "  EXPERIMENT ONLY. Snapshots the app's primary mirror e2e/ (without node_modules, run output, login sessions or credentials) to",
  "  <mirrors>/.warm/<app>/<l>/, restores a mirror's e2e/ to a snapshot, checks that the snapshot's auth.setup.ts is no longer the stock seed,",
  "  and loads a snapshot into the app's suite store (what a pipeline run restores after its checkout).",
  "  snapshot, restore and seed-store refuse unless the queue is idle. Run inside the orchestrator container.",
].join("\n");

const LISTED = 40;

function list(out: (line: string) => void, title: string, paths: readonly string[]): void {
  if (paths.length === 0) return;
  out(`  ${title} (${paths.length}):`);
  for (const p of paths.slice(0, LISTED)) out(`    ${p}`);
  if (paths.length > LISTED) out(`    ... and ${paths.length - LISTED} more`);
}

/** Returns the process exit code: 0 ok (verify: warm), 1 refused, failed or cold, 2 bad usage. */
export async function main(argv: string[], deps: WarmDeps): Promise<number> {
  const out = deps.out;
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    out(parsed.problem);
    for (const line of USAGE.split("\n")) out(line);
    return 2;
  }
  const { command, app, label, dryRun } = parsed;
  try {
    const labelDir = warmSnapshotDir(deps.warmRoot(), app, label);
    if (command === "verify") {
      const status = warmStatus(loadSnapshot(labelDir, label));
      out(`[warm] ${app}/${label}: ${status.warm ? "WARM" : "COLD"}`);
      out(`  ${AUTH_SETUP_FILE}: ${status.present ? "present" : "absent"}; ${STOCK_SEED_MARKER} marker: ${status.carriesMarker ? "present" : "absent"}; shipped seed revision: ${status.stockSeed ? "yes" : "no"}`);
      out(`  ${status.note}`);
      return status.warm ? 0 : 1;
    }

    if (command === "seed-store") {
      await deps.assertQueueIdle();
      const snapshot = loadSnapshot(labelDir, label);
      const seeded = await deps.seedStore(app, snapshot.files, label);
      out(`[warm] seeded the suite store of ${app} with ${app}/${label}: ${seeded.entries} files, ${seeded.bytes} bytes (what the store held is replaced)`);
      const status = warmStatus(snapshot);
      out(`[warm] login: ${status.warm ? "WARM" : "COLD"}: ${status.note}`);
      return 0;
    }

    if (!dryRun) await deps.assertQueueIdle();
    const mirror = deps.primaryMirror(app);
    if (command === "snapshot") {
      const manifest = createSnapshot({ ...mirror, labelDir, app, label, now: deps.now() });
      const total = manifest.files.reduce((n, f) => n + f.bytes, 0);
      out(`[warm] snapshot ${app}/${label}: ${manifest.files.length} files, ${total} bytes, from ${mirror.e2eDir} to ${labelDir}/${SNAPSHOT_SUITE_DIR}`);
      list(out, "left out", manifest.excluded.map((x) => `${x.path}  [${x.reason}]`));
      const status = warmStatus(loadSnapshot(labelDir, label));
      out(`[warm] login: ${status.warm ? "WARM" : "COLD"}: ${status.note}`);
      return 0;
    }

    const snapshot = loadSnapshot(labelDir, label);
    const summary = restoreSuite(snapshot, mirror, { dryRun });
    out(`[warm] ${dryRun ? "restore (dry run, nothing changed)" : "restored"} ${mirror.e2eDir} to ${app}/${label}: ${summary.added.length} added, ${summary.changed.length} replaced, ${summary.removed.length} removed, ${summary.unchanged} unchanged${summary.keptNodeModules ? "; node_modules kept" : ""}`);
    list(out, "added", summary.added);
    list(out, "replaced", summary.changed);
    list(out, "removed", summary.removed);
    return 0;
  } catch (err) {
    out(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/* ── the real collaborators ────────────────────────────────────────────────────────── */

/** Loads a snapshot's files into an app's suite store (data/suites/<app>/), replacing what it held. The engine's own adapter does it, so the store is exactly what a run would have captured. */
export async function seedSuiteStore(app: string, files: ReadonlyMap<string, Buffer>, label: string): Promise<{ entries: number; bytes: number }> {
  const { SuiteStoreAdapter } = await import("../qa-engine/src/contexts/workspace-and-publication/infrastructure/suite-store.adapter.ts");
  const { appSuiteStoreDir } = await import("../src/server/run-engine-factory.ts");
  const { qayabaRoot } = await import("../src/paths.ts");
  const { loadAppConfig } = await import("../src/orchestrator/config-loader.ts");
  const store = new SuiteStoreAdapter({
    storeDir: appSuiteStoreDir(qayabaRoot(), app),
    app,
    repo: loadAppConfig(app).repo,
    specRelDir: DEFAULT_SUITE_DIR,
    listTracked: async () => new Map(),
    now: () => new Date(),
  });
  return store.seed(files, { label });
}

/** The queue, the app configs and the mirrors of the orchestrator container, imported lazily so a test that injects its own never opens them. */
export async function defaultDeps(env: Record<string, string | undefined> = process.env): Promise<WarmDeps> {
  const { assertQueueIdle, defaultService } = await import("./efficiency-benchmark.ts");
  const { loadAppConfig } = await import("../src/orchestrator/config-loader.ts");
  const { workdirRoot } = await import("../src/integrations/repo-mirror.ts");
  const service = await defaultService(env);
  return {
    assertQueueIdle: () => assertQueueIdle(service),
    warmRoot: () => join(workdirRoot(), WARM_SNAPSHOTS_DIR),
    primaryMirror: (app) => {
      const config = loadAppConfig(app);
      const mirrorDir = join(workdirRoot(), config.repo.replaceAll("/", "__"));
      return { repo: config.repo, mirrorDir, e2eDir: join(mirrorDir, DEFAULT_SUITE_DIR) };
    },
    now: () => new Date(),
    out: (line) => console.log(line),
    seedStore: (app, files, label) => seedSuiteStore(app, files, label),
  };
}

/* Run as a script (not when imported by a test). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  defaultDeps()
    .then((deps) => main(process.argv.slice(2), deps))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
