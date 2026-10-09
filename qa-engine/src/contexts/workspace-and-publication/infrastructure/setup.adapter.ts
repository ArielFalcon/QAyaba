/* E2E project setup: bootstrap the seed if missing, then install deps. This adapter never reads env — seedDir is injected. FAILURE_CAPTURE_BLOCK is data appended into the watched app's fixtures (runs in that app's Playwright process), not code this module executes.
   The project directory is one the agent writes into, and part of it (node_modules, so the install marker) outlives a run: every file of it that setup reads or replaces (the fixtures file, the ignore file, the login setup, the Playwright config, the lock file, the install marker) goes through the strict read and write of spec-path-confinement, never a bare fs call. A file it cannot vouch for (a link, a named pipe, a directory, a file over its cap) fails the setup aloud, which the pipeline reports as an infra-error: it is never waited on, followed or skipped. The one exception is what would fail every later run for good: the install marker and the node_modules above it survive a clean, so what refuses them is removed (a name unlinked, a directory set aside) without being opened or followed, said aloud, and the marker is read once more. The seed is the orchestrator's own and is read plainly; it is copied in, and flows/ made, through the same strict calls, so that nothing is made or written through a link. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isStockAuthSetup } from "../../../shared-infrastructure/e2e-seed/auth-setup-seed.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import {
  ConfinedPathError,
  MAX_SPEC_SOURCE_BYTES,
  ensureOwnedSpecDir,
  purgeRefusedDirectory,
  purgeRefusedPath,
  readFailureReason,
  readOwnedSpecFile,
  writeOwnedSpecFile,
  type OwnedSpecRead,
  type PurgeResult,
  type SpecRoot,
} from "../../../shared-infrastructure/spec-path-confinement.ts";

export const DEFAULT_E2E_INSTALL_TIMEOUT_MS = 600_000;

/* The install marker holds one hash; the lock file is the largest thing an install is judged by, and a real one is a few megabytes at most. */
export const MAX_INSTALL_MARKER_BYTES = 1024;
export const MAX_LOCK_FILE_BYTES = 32 * 1024 * 1024;

/* The install runs the repo's own lifecycle scripts, which can write without limit; nothing reads its output beyond the exit status, so only a small newest tail is kept. */
const E2E_INSTALL_OUTPUT_KEEP_CHARS = 16_000;

export const FAILURE_CAPTURE_MARKER = ">>> qa-failure-capture (system-owned: do not edit) >>>";

const FAILURE_CAPTURE_END_MARKER = "// <<< qa-failure-capture <<<\n";

/*
 * sha256 of every earlier capture block a repo's fixtures.ts received — appended by setup or carried
 * by the seed's fixtures.ts (the whole block, from the newline before its opening marker through its
 * closing marker line). A block that still byte-matches one is upgraded in place; an edited block is
 * left as-is. Add the outgoing block's hash whenever FAILURE_CAPTURE_BLOCK changes.
 */
const EARLIER_FAILURE_CAPTURE_BLOCKS: ReadonlySet<string> = new Set([
  "0665bc90120cf1f2da387182d638f279cafb27d3c36850523a26164b69e57569",
  "4bc9fb09d3b999d50291acce880217b2aeb00cbe45cfdccf4b24598b999458a4",
  "3ebe14ac5cdf1b445c37db2acf6cbf53f1f02057b3e58f0076a46c7bd6a32a3c",
  "aaaec869a29d0d5066cb7cb9ab89c829bae7b04797a9e0e5372fef24de034550",
  "607112cee45f4edf134ecefa660e815f6e40dfce2b9a0f19184f4e5372d935b1",
  "9490d34eb64c08551d6c9ac3dee476d21d5f227c5631e5b7af0155d4d4241569",
]);

/*
 * The one capture block revision appended without its markers, known by its first line, its length
 * and its sha256. A repo holding it byte-for-byte gets the current block in its place; appending
 * beside any copy of it would redeclare its variables, so an edited copy is left as it is and nothing
 * is appended.
 */
const UNMARKED_FAILURE_CAPTURE_BLOCK = {
  firstLine: "\nlet errorResponses = [];\n",
  length: 3473,
  sha256: "65d0916709e4b89b743a151d4b001bfdabdef20d8f0180b0ea3af3e52ac5e85a",
} as const;

/*
 * sha256 of every playwright.config.ts seed revision shipped into watched repos, the current one
 * included. A repo copy that byte-matches one is stock and follows the current seed; any other copy
 * is the repo's own. Add the new hash whenever config/e2e/playwright.config.ts changes.
 */
const PLAYWRIGHT_CONFIG_SEED_REVISIONS: ReadonlySet<string> = new Set([
  "c59f2f5ca105b676c11538ee7a70bd624ca34c5a56d025cbcbe16e3b6d0ab8f6",
  "6ee7f15fd63364d4626877075c3782a425f1e29e22fa14a1709ca87aaaeb64be",
  "d665eb1d95e06d917b9ffbce2486f07b1ee12f5f73dc98400393cf6ca621d7ca",
  "35254a3ed113dd097aec01997cd864545fd2c222227f0841a3264c9978ae779a",
]);

const PLAYWRIGHT_CONFIG_MANAGED_KEYS = ["actionTimeout", "testIdAttribute", "storageState", "PW_AUTH_SETUP"] as const;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export const FAILURE_CAPTURE_BLOCK = `
// >>> qa-failure-capture (system-owned: do not edit) >>>
// Captures the aria snapshot of the page at the failure point, the page's final URL, and the HTTP
// status of the most-recent correlated 5xx server error, writing them to QA_FAILURE_CAPTURE_DIR so
// the orchestrator can ground the fix-loop regeneration and surface runtime evidence to the adjudicator
// and reviewer. Best-effort only: the page may be closed on a nav-crash (try/catch swallows), and the
// entire block is a no-op when QA_FAILURE_CAPTURE_DIR is unset.
//
// SELF-CONTAINED: this exact block is also appended (append-only) into existing repos'
// fixtures.ts by the orchestrator, so it CANNOT assume any top-level import is present.
// node:fs/path/crypto are pulled in via dynamic import() INSIDE the async afterEach —
// a CommonJS-style synchronous load is not defined in this native-ESM module
// ("type":"module") and would throw a ReferenceError that the catch would swallow.
let errorResponses: { url: string; status: number; resourceType: string }[] = [];
// App-defect detection: browser console \`error\`-level entries and uncaught \`pageerror\`
// exceptions observed during the current test. Reset per-test (mirrors errorResponses) so a reused
// page never cross-attributes a PRIOR test's runtime errors to the current one. Best-effort: the
// orchestrator's runtime-error classifier turns this into a diagnostic signal ONLY — it never
// blocks or masks a real generated-test defect.
let runtimeErrors: { type: string; text: string }[] = [];
test.beforeEach(async ({ page }) => {
  if (!process.env.QA_FAILURE_CAPTURE_DIR) return; // no-op when capture is disabled (zero overhead)
  errorResponses = [];                               // reset unconditionally so reused pages never cross-attribute
  runtimeErrors = [];                                 // same per-test reset discipline
  try {
    page.on('response', (r) => {
      try { const s = r.status(); if (s >= 400) errorResponses.push({ url: r.url(), status: s, resourceType: r.request().resourceType() }); } catch {}
    });
  } catch {}
  try {
    page.on('console', (msg) => {
      try {
        if (msg.type() !== 'error') return; // only error-level; warnings/logs are not runtime evidence
        runtimeErrors.push({ type: 'error', text: msg.text() });
      } catch {}
    });
  } catch {}
  try {
    page.on('pageerror', (err) => {
      try { runtimeErrors.push({ type: 'pageerror', text: err.message ?? String(err) }); } catch {}
    });
  } catch {}
});
test.afterEach(async ({ page }, testInfo) => {
  const dir = process.env.QA_FAILURE_CAPTURE_DIR;
  if (!dir) return;                                   // degrade to no-op when the orchestrator did not ask
  if (testInfo.status === testInfo.expectedStatus) return; // only on unexpected status (a real failure)
  try {
    const { writeFileSync } = await import("node:fs");
    const { join, basename } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const yaml = await page.locator("body").ariaSnapshot(); // the REAL post-failure page state
    // title = the describe › test chain (drop the leading project element), MATCHING the stream
    // reporter's _name. The orchestrator's harvest keys off this: the JSON report's case name is
    // \`file › describe › test\`, whose trailing segments equal this title's segments.
    const title = testInfo.titlePath.filter(Boolean).slice(1).join(" › ");
    const project = testInfo.project.name;
    // file = the spec's basename. Two tests with the SAME describe › test chain in DIFFERENT spec
    // files share a title; the file disambiguates them so neither the dump identity nor the harvest
    // match attaches the wrong DOM. Stored in the body AND folded into the filename hash below.
    const file = basename(testInfo.file ?? "");
    // Filename: project + a short hash of file + title + retry. The project keeps two projects
    // (desktop/mobile) running the same spec from clobbering each other; the (file + title) HASH
    // (not an 80-char truncation) keeps two long titles sharing an 80-char prefix — or two same-titled
    // tests in different files — from colliding. The body is authoritative for matching (project/file/
    // title); the filename only guarantees uniqueness + retry.
    const hash = createHash("sha1").update(\`\${file}/\${title}\`).digest("hex").slice(0, 12);
    const safeProject = project.replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
    // Compute finalUrl (sync, always available in afterEach) and the attributed httpStatus
    // via the attribution heuristic (5xx-only, resource-type-gated, same-origin correlated, last).
    // (Path-family intentionally omitted: in a SPA the finalUrl is the UI route (e.g. /orders) while
    // the causing 5xx is the API call (e.g. /api/orders) — different path segments — so path-family
    // would drop legitimate API 5xxs; same-origin is the correct, not-too-tight correlation.)
    const finalUrl = page.url();
    let httpStatus: number | undefined;
    try {
      let finalUrlOrigin = '';
      try { finalUrlOrigin = new URL(finalUrl).origin; } catch {}
      const FOREGROUND = new Set(['document', 'fetch', 'xhr']);
      const BACKGROUND = new Set(['ping', 'beacon', 'image', 'stylesheet', 'font', 'media']);
      const survivors = errorResponses.filter((e) => {
        if (e.status < 500 || e.status > 599) return false; // 5xx only
        if (BACKGROUND.has(e.resourceType)) return false;    // exclude background resource types
        if (!FOREGROUND.has(e.resourceType)) return false;   // keep only foreground interactions
        try {
          const eOrigin = new URL(e.url).origin;
          return eOrigin === finalUrlOrigin;                  // same-origin correlation
        } catch { return false; }
      });
      if (survivors.length > 0) httpStatus = survivors[survivors.length - 1]!.status; // last survivor
    } catch {}
    // Runtime errors: dedupe (same type+text pair collapses to one entry — a repeated framework error
    // firing on every change-detection cycle would otherwise flood the dump), cap at ~15 entries
    // (the orchestrator only needs enough to classify, not an exhaustive log), and truncate each
    // entry's text to ~200 chars (the classifier only needs the first line/signature, not a full
    // stack). Best-effort: any failure here still lets the rest of the dump (yaml/finalUrl/httpStatus)
    // write normally.
    let dedupedRuntimeErrors: { type: string; text: string }[] = [];
    try {
      const RUNTIME_ERRORS_CAP = 15;
      const RUNTIME_ERROR_TEXT_CAP = 200;
      const seen = new Set<string>();
      for (const e of runtimeErrors) {
        const text = e.text.length > RUNTIME_ERROR_TEXT_CAP ? e.text.slice(0, RUNTIME_ERROR_TEXT_CAP) : e.text;
        const key = \`\${e.type} \${text}\`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedupedRuntimeErrors.push({ type: e.type, text });
        if (dedupedRuntimeErrors.length >= RUNTIME_ERRORS_CAP) break;
      }
    } catch { dedupedRuntimeErrors = []; }
    writeFileSync(
      join(dir, \`\${safeProject}__\${hash}__\${testInfo.retry}.json\`),
      JSON.stringify({ project, file, title, retry: testInfo.retry, yaml, finalUrl, httpStatus, runtimeErrors: dedupedRuntimeErrors }),
    );
  } catch { /* page may be closed on a nav-crash — best-effort, never fail the run */ }
});
// <<< qa-failure-capture <<<
`;

export interface SetupOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SetupAdapterFsDeps {
  exists(path: string): boolean;
  /* Copies the orchestrator's seed into the project directory: the seed is read plainly, and everything it is copied into goes in through the strict calls (see copySeedStrictly). */
  cp(src: string, dest: string, opts?: { recursive?: boolean; filter?: (src: string) => boolean }): void;
  /* The orchestrator's own seed files; never a file of the project. */
  read(path: string): string;
  /* Makes a directory of the project that is not there, and refuses one that is a link or no directory. */
  mkdir(path: string): void;
  /* The files of the project the agent can write into, read and replaced strictly below the project directory (see the header). */
  readOwned(root: SpecRoot, rel: string, maxBytes: number): OwnedSpecRead;
  writeOwned(root: SpecRoot, rel: string, text: string | Uint8Array): void;
  /* Removes what refuses the strict read of a file of the project, without opening or following it (see purgeRefusedPath). */
  purgeRefused(root: SpecRoot, rel: string, maxBytes: number): PurgeResult;
  /* Removes what is not an ordinary directory where the project should have one of the orchestrator's own (see purgeRefusedDirectory). */
  purgeRefusedDirectory(root: SpecRoot, rel: string): PurgeResult;
}

/* Names a refusal by the path setup asked for, which is what an operator looks for, instead of the path below the project directory that the strict calls were given. */
function namedAt<T>(path: string, run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof ConfinedPathError) throw new ConfinedPathError(path, err.reason);
    throw err;
  }
}

/* The file whose presence says that a directory is a project: a directory that has it is not seeded again. */
const PROJECT_MARK_FILE = "package.json";

/* The seed is the orchestrator's own and read plainly; the project directory it is copied into is the agent's. Every directory and file goes in through the strict calls of spec-path-confinement, so that a link where a directory or a file of the project belongs is never written through (a directory or a file that is a link is refused, loudly), and a project directory that is itself a link is refused. The mark of a project is written last: a copy that fails half way (a link in the way) must leave a directory that is not taken for seeded, or no later setup would copy the rest. */
function copySeedStrictly(seedDir: string, e2eDir: string, filter: (src: string) => boolean = () => true): void {
  if (!filter(seedDir)) return;
  try {
    lstatSync(e2eDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(e2eDir, { recursive: true });
  }
  const root: SpecRoot = { mirrorDir: e2eDir, specDir: e2eDir };
  namedAt(e2eDir, () => ensureOwnedSpecDir(root, "."));
  const copy = (from: string, rel: string): void => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const src = join(from, entry.name);
      if (!filter(src)) continue;
      const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        namedAt(join(e2eDir, entryRel), () => ensureOwnedSpecDir(root, entryRel));
        copy(src, entryRel);
      } else if (entry.isFile()) {
        if (rel === "" && entry.name === PROJECT_MARK_FILE) continue;
        namedAt(join(e2eDir, entryRel), () => writeOwnedSpecFile(root, entryRel, readFileSync(src)));
      }
    }
  };
  copy(seedDir, "");
  const mark = join(seedDir, PROJECT_MARK_FILE);
  if (filter(mark) && existsSync(mark)) namedAt(join(e2eDir, PROJECT_MARK_FILE), () => writeOwnedSpecFile(root, PROJECT_MARK_FILE, readFileSync(mark)));
}

export const nodeFsDeps: SetupAdapterFsDeps = {
  exists: existsSync,
  cp: (src, dest, opts) => copySeedStrictly(src, dest, opts?.filter),
  read: (path) => readFileSync(path, "utf8"),
  mkdir: (path) => namedAt(path, () => ensureOwnedSpecDir({ mirrorDir: dirname(path), specDir: dirname(path) }, basename(path))),
  readOwned: (root, rel, maxBytes) => readOwnedSpecFile(root, rel, maxBytes),
  writeOwned: (root, rel, text) => writeOwnedSpecFile(root, rel, text),
  purgeRefused: (root, rel, maxBytes) => purgeRefusedPath(root, rel, maxBytes),
  purgeRefusedDirectory: (root, rel) => purgeRefusedDirectory(root, rel),
};

/* What setup keeps in the project directory, as paths below it. */
const FIXTURES_FILE = "fixtures.ts";
const GITIGNORE_FILE = ".gitignore";
const AUTH_SETUP_FILE = "auth.setup.ts";
const PLAYWRIGHT_CONFIG_FILE = "playwright.config.ts";
const LOCK_FILE = "package-lock.json";
const INSTALL_MARKER_FILE = "node_modules/.install-hash";

/* What the runs make in the project that is the orchestrator's own and that the project's .gitignore keeps git from cleaning. The measured file is small; one past this is not what a run wrote. */
const SYSTEM_OWNED_DIRECTORIES = [".qa/coverage", ".qa/fault-injection"] as const;
const SYSTEM_OWNED_FILES = [".qa/measured.json"] as const;
const MAX_MEASURED_FILE_BYTES = 1024 * 1024;

export interface SetupAdapterDeps {
  fs: SetupAdapterFsDeps;
  runner: SandboxedBinaryRunner;
  seedDir: string;
}

export class SetupAdapter {
  constructor(private readonly deps: SetupAdapterDeps) {}

  async setup(e2eDir: string, opts?: SetupOptions): Promise<void> {
    if (!this.hasProject(e2eDir)) this.bootstrap(e2eDir);
    this.ensureSpecDir(e2eDir);
    this.ensureFailureCapture(e2eDir);
    this.ensureAuthSetup(e2eDir);
    this.ensureSessionGitignore(e2eDir);
    this.ensurePlaywrightEnvKeys(e2eDir);
    this.purgeSystemOwned(e2eDir);
    if (this.installIsCurrent(e2eDir)) {
      console.log("[qa] e2e dependencies up to date; skipping npm ci");
      return;
    }
    if (opts?.signal?.aborted) throw new Error("e2e dependency install aborted by operator cancel");

    /* Race the install against a timeout at the orchestration level (defense in depth: the real SandboxedBinaryRunner also kills the tree on its own internal timeout). On timeout we throw, which the pipeline maps to infra-error — same pattern as setupCodeProject. */
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_E2E_INSTALL_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`e2e dependency install timed out after ${timeoutMs}ms — killed`)), timeoutMs);
    });
    try {
      await Promise.race([this.install(e2eDir, opts), timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
    this.markInstallCurrent(e2eDir);
  }

  private hasProject(e2eDir: string): boolean {
    return this.deps.fs.exists(join(e2eDir, PROJECT_MARK_FILE));
  }

  private bootstrap(e2eDir: string): void {
    this.deps.fs.cp(this.deps.seedDir, e2eDir, {
      recursive: true,
      filter: (src) => !src.includes("node_modules"),
    });
  }

  /* The directory the generated specs go into. One that is a link out of the project, a named pipe or a file fails the setup: it is made through no link, and the agent's specs are never written through one. */
  ensureSpecDir(e2eDir: string): void {
    this.deps.fs.mkdir(join(e2eDir, "flows"));
  }

  /* What the runs leave in the project and the orchestrator reads back: the directories of the coverage dumps and of the fault-injection counters, and the measured file. The project's .gitignore keeps git from cleaning them (`git clean -fd` leaves what it ignores), so what the agent plants in their place outlives the run: a link or a named pipe where a directory belongs refuses the strict read of everything a later run leaves in it, and the coverage or the score is unknown for good. Whatever is not an ordinary directory (or file) there is removed, without being opened or followed, and said; the run makes the directory again. What these protect is a signal, so a removal that cannot be made is said and does not fail the setup. */
  private purgeSystemOwned(e2eDir: string): void {
    const root = this.projectRoot(e2eDir);
    const owned: Array<{ rel: string; what: string; purge: () => PurgeResult }> = [
      ...SYSTEM_OWNED_DIRECTORIES.map((rel) => ({ rel, what: "an ordinary directory", purge: () => this.deps.fs.purgeRefusedDirectory(root, rel) })),
      ...SYSTEM_OWNED_FILES.map((rel) => ({ rel, what: "an ordinary file", purge: () => this.deps.fs.purgeRefused(root, rel, MAX_MEASURED_FILE_BYTES) })),
    ];
    for (const { rel, what, purge } of owned) {
      try {
        const purged = purge();
        if ("nothing" in purged) continue;
        console.warn(`[qa] WARNING: ${join(e2eDir, purged.removed)} stood where ${join(e2eDir, rel)} is made, and was not ${what}; it was ${purged.how === "unlinked" ? "removed" : "set aside"} without being opened or followed, and the run makes it again.`);
      } catch (err) {
        console.warn(`[qa] WARNING: ${join(e2eDir, rel)} could not be checked or cleared (${readFailureReason(err)}); what a run leaves there may be unusable, and the coverage or the score that depends on it is unknown.`);
      }
    }
  }

  /* The project directory is its own root: nothing below it is read or written through a link, and nothing outside it. */
  private projectRoot(e2eDir: string): SpecRoot {
    return { mirrorDir: e2eDir, specDir: e2eDir };
  }

  /* The bytes of a file of the project, or undefined when it is not there. A file setup cannot vouch for fails the setup, naming the file as `e2eDir` has it and saying why; any other failure to read it is thrown as it is. */
  private readProject(e2eDir: string, rel: string, maxBytes: number): Buffer | undefined {
    const read = this.deps.fs.readOwned(this.projectRoot(e2eDir), rel, maxBytes);
    if ("absent" in read) return undefined;
    if ("reason" in read) throw new ConfinedPathError(join(e2eDir, rel), read.reason);
    return read.bytes;
  }

  private readProjectText(e2eDir: string, rel: string): string | undefined {
    return this.readProject(e2eDir, rel, MAX_SPEC_SOURCE_BYTES)?.toString("utf8");
  }

  /* Replaces a file of the project whole, through a temporary file renamed over it, so that nothing is written through a link; a refusal names the file as `e2eDir` has it. */
  private writeProject(e2eDir: string, rel: string, text: string): void {
    try {
      this.deps.fs.writeOwned(this.projectRoot(e2eDir), rel, text);
    } catch (err) {
      if (err instanceof ConfinedPathError) throw new ConfinedPathError(join(e2eDir, rel), err.reason);
      throw err;
    }
  }

  /**
   * Appends the failure-capture block to a repo's fixtures.ts that has none, and upgrades in place a
   * block that is still byte-for-byte an earlier appended revision. Every other line — and a block
   * someone edited — is left as-is.
   */
  ensureFailureCapture(e2eDir: string): void {
    const src = this.readProjectText(e2eDir, FIXTURES_FILE);
    if (src === undefined) return;
    const start = src.indexOf(`\n// ${FAILURE_CAPTURE_MARKER}`);
    if (start === -1) {
      if (!src.includes(FAILURE_CAPTURE_MARKER)) this.addCaptureBlock(e2eDir, src);
      return;
    }
    const endMarker = src.indexOf(FAILURE_CAPTURE_END_MARKER, start);
    if (endMarker === -1) return;
    const end = endMarker + FAILURE_CAPTURE_END_MARKER.length;
    if (!EARLIER_FAILURE_CAPTURE_BLOCKS.has(sha256(src.slice(start, end)))) return;
    this.writeProject(e2eDir, FIXTURES_FILE, src.slice(0, start) + FAILURE_CAPTURE_BLOCK + src.slice(end));
  }

  /* Appends the block to a fixtures.ts that has none, or puts it in place of the block appended without markers. */
  private addCaptureBlock(e2eDir: string, src: string): void {
    const { firstLine, length, sha256: unmarkedHash } = UNMARKED_FAILURE_CAPTURE_BLOCK;
    const at = src.indexOf(firstLine);
    if (at === -1) {
      this.writeProject(e2eDir, FIXTURES_FILE, src + FAILURE_CAPTURE_BLOCK);
      return;
    }
    if (sha256(src.slice(at, at + length)) !== unmarkedHash) return;
    this.writeProject(e2eDir, FIXTURES_FILE, src.slice(0, at) + FAILURE_CAPTURE_BLOCK + src.slice(at + length));
  }

  /** Keeps the Playwright session directory out of the suite PR. Idempotent. */
  ensureSessionGitignore(e2eDir: string): void {
    const line = ".auth/";
    const src = this.readProjectText(e2eDir, GITIGNORE_FILE);
    if (src === undefined) {
      this.writeProject(e2eDir, GITIGNORE_FILE, `${line}\n`);
      return;
    }
    if (src.split("\n").some((entry) => entry.trim() === line)) return;
    this.writeProject(e2eDir, GITIGNORE_FILE, src + (src.endsWith("\n") || src.length === 0 ? `${line}\n` : `\n${line}\n`));
  }

  /**
   * Copies the current login seed when the repo has none, and replaces a stock copy (byte-for-byte a
   * shipped seed revision). A login rewritten for the app is the repo's own and is left as-is.
   */
  ensureAuthSetup(e2eDir: string): void {
    const seed = join(this.deps.seedDir, AUTH_SETUP_FILE);
    if (!this.deps.fs.exists(seed)) return;
    const existing = this.readProjectText(e2eDir, AUTH_SETUP_FILE);
    if (existing === undefined) {
      this.writeProject(e2eDir, AUTH_SETUP_FILE, this.deps.fs.read(seed));
      return;
    }
    if (isStockAuthSetup(existing)) this.followSeed(AUTH_SETUP_FILE, e2eDir, existing);
  }

  /**
   * Replaces a stock e2e/playwright.config.ts (byte-for-byte a shipped seed revision) with the
   * current seed. Any other config is the repo's own and is never overwritten; one that lacks a
   * managed env-passthrough key gets a warning naming it.
   */
  ensurePlaywrightEnvKeys(e2eDir: string): void {
    const src = this.readProjectText(e2eDir, PLAYWRIGHT_CONFIG_FILE);
    if (src === undefined) return;
    if (PLAYWRIGHT_CONFIG_SEED_REVISIONS.has(sha256(src))) {
      this.followSeed(PLAYWRIGHT_CONFIG_FILE, e2eDir, src);
      return;
    }
    const missing = PLAYWRIGHT_CONFIG_MANAGED_KEYS.filter((key) => !src.includes(key));
    if (missing.length === 0) return;
    console.warn(
      `[qa] ${join(e2eDir, PLAYWRIGHT_CONFIG_FILE)} is missing managed env-passthrough key(s) [${missing.join(", ")}] and is not a ` +
        `shipped seed revision — the repo owns it, so it will NOT be overwritten. Add the missing ` +
        `key(s) manually if this repo wants them.`,
    );
  }

  /* Puts the current seed `name` in place of the stock copy of it in the project, unless that already is the current seed. */
  private followSeed(name: string, e2eDir: string, stockCopy: string): void {
    const seed = join(this.deps.seedDir, name);
    if (!this.deps.fs.exists(seed)) return;
    const current = this.deps.fs.read(seed);
    if (current === stockCopy) return;
    this.writeProject(e2eDir, name, current);
  }

  /* isInstallCurrent, with one way out of a marker that the strict read refuses. node_modules survives `git clean -fd -e node_modules` from one run to the next, so what the agent planted at the marker (or at node_modules itself) would refuse the read on every later run, for good, and end the app's QA. The entry that refuses it is removed without being opened or followed (see purgeRefusedPath), said aloud, and the marker is read once more: with none the install is not skipped, so it runs. A second refusal, a removal that fails and a refusal of anything but the marker fail the setup. */
  private installIsCurrent(e2eDir: string): boolean {
    try {
      return this.isInstallCurrent(e2eDir);
    } catch (err) {
      if (!(err instanceof ConfinedPathError) || err.path !== join(e2eDir, INSTALL_MARKER_FILE) || !this.purgeMarker(e2eDir, err)) throw err;
      return this.isInstallCurrent(e2eDir);
    }
  }

  /* Whether something was removed. */
  private purgeMarker(e2eDir: string, refusal: ConfinedPathError): boolean {
    let purged: PurgeResult;
    try {
      purged = this.deps.fs.purgeRefused(this.projectRoot(e2eDir), INSTALL_MARKER_FILE, MAX_INSTALL_MARKER_BYTES);
    } catch (err) {
      console.warn(`[qa] WARNING: ${refusal.path} could not be vouched for (${refusal.reason}) and could not be removed (${readFailureReason(err)}); setup fails.`);
      return false;
    }
    if ("nothing" in purged) return false;
    console.warn(`[qa] WARNING: ${join(e2eDir, purged.removed)} could not be vouched for (${refusal.reason}); it was ${purged.how === "unlinked" ? "removed" : "set aside"} without being opened, and the install is checked once more.`);
    return true;
  }

  private getLockHash(e2eDir: string): string | null {
    const lock = this.readProject(e2eDir, LOCK_FILE, MAX_LOCK_FILE_BYTES);
    return lock === undefined ? null : createHash("sha256").update(lock).digest("hex");
  }

  /* The install is current when the marker the last install left holds the hash of the lock. A marker setup cannot vouch for (a link, a named pipe, a directory, one over its cap, or a node_modules that is not a directory) is refused with a ConfinedPathError at the marker's path (installIsCurrent decides what follows): it is never trusted, never waited on and never skipped over, since it survives from one run to the next. A marker that is only unreadable says nothing, and the install that follows replaces it. */
  private isInstallCurrent(e2eDir: string): boolean {
    let marker: Buffer | undefined;
    try {
      marker = this.readProject(e2eDir, INSTALL_MARKER_FILE, MAX_INSTALL_MARKER_BYTES);
    } catch (err) {
      if (err instanceof ConfinedPathError) throw err;
      console.warn(`[qa] WARNING: ${join(e2eDir, INSTALL_MARKER_FILE)} could not be read (${readFailureReason(err)}); the e2e dependencies are installed again.`);
      return false;
    }
    if (marker === undefined) return false;
    return marker.toString("utf8").trim() === this.getLockHash(e2eDir);
  }

  private markInstallCurrent(e2eDir: string): void {
    const hash = this.getLockHash(e2eDir);
    if (!hash) return;
    this.writeProject(e2eDir, INSTALL_MARKER_FILE, hash);
  }

  /* `npm ci` when there is a lockfile; otherwise `npm install`. scrubEnv({ extraAllowed: /^DEV_/ }) keeps the app's DEV_* login creds while dropping the orchestrator's own secrets. A hung install must not block the sequential queue: the runner times out with timedOut:true (never rejects), so this method throws on that signal. */
  private async install(e2eDir: string, opts?: SetupOptions): Promise<void> {
    /* The lock is read here (strictly) and not probed, so that an install is never started over a lock that setup could not vouch for: a runner handed a named pipe for it would wait on it until its own timeout. */
    const useCi = this.getLockHash(e2eDir) !== null;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_E2E_INSTALL_TIMEOUT_MS;
    const result = await this.deps.runner.run({
      command: "npm",
      args: [useCi ? "ci" : "install"],
      cwd: e2eDir,
      env: scrubEnv({ extraAllowed: /^DEV_/ }),
      timeoutMs,
      outputKeepChars: E2E_INSTALL_OUTPUT_KEEP_CHARS,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    if (result.timedOut) {
      /* timedOut:true covers both the runner's timeout and an operator abort. Disambiguate via the signal: there is no await between the runner promise settling and this check, so an abort cannot interleave as a genuine timeout. */
      if (opts?.signal?.aborted) {
        throw new Error("e2e dependency install aborted by operator cancel");
      }
      throw new Error(`npm ${useCi ? "ci" : "install"} in e2e timed out after ${timeoutMs}ms — killed`);
    }
    if (result.exitCode !== 0) {
      throw new Error(`npm ${useCi ? "ci" : "install"} in e2e failed (code ${result.exitCode})`);
    }
  }
}
