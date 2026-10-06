/* E2E project setup: bootstrap the seed if missing, then install deps. This adapter never reads env — seedDir is injected. FAILURE_CAPTURE_BLOCK is data appended into the watched app's fixtures (runs in that app's Playwright process), not code this module executes. */
import { createHash } from "node:crypto";
import { existsSync, cpSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { E2E_AUTH_FILE, type E2eAuthConfig } from "../../../shared-kernel/e2e-auth.ts";
import { isStockAuthSetup } from "../../../shared-infrastructure/e2e-seed/auth-setup-seed.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";

export const DEFAULT_E2E_INSTALL_TIMEOUT_MS = 600_000;

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
  cp(src: string, dest: string, opts?: { recursive?: boolean; filter?: (src: string) => boolean }): void;
  read(path: string): string;
  readBytes(path: string): Buffer;
  write(path: string, content: string): void;
  append(path: string, content: string): void;
  mkdir(path: string): void;
  remove?(path: string): void;
}

export const nodeFsDeps: SetupAdapterFsDeps = {
  exists: existsSync,
  cp: (src, dest, opts) => cpSync(src, dest, opts),
  read: (path) => readFileSync(path, "utf8"),
  readBytes: (path) => readFileSync(path),
  write: writeFileSync,
  append: appendFileSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  remove: (path) => rmSync(path, { force: true }),
};

export interface SetupAdapterDeps {
  fs: SetupAdapterFsDeps;
  runner: SandboxedBinaryRunner;
  seedDir: string;
  /* The app's declared central-login flow, materialized into the working copy each run (absent → any stale copy is removed). */
  authConfig?: E2eAuthConfig;
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
    this.ensureAuthConfig(e2eDir);
    if (this.isInstallCurrent(e2eDir)) {
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
    return this.deps.fs.exists(join(e2eDir, "package.json"));
  }

  private bootstrap(e2eDir: string): void {
    this.deps.fs.cp(this.deps.seedDir, e2eDir, {
      recursive: true,
      filter: (src) => !src.includes("node_modules"),
    });
  }

  private ensureSpecDir(e2eDir: string): void {
    this.deps.fs.mkdir(join(e2eDir, "flows"));
  }

  /**
   * Appends the failure-capture block to a repo's fixtures.ts that has none, and upgrades in place a
   * block that is still byte-for-byte an earlier appended revision. Every other line — and a block
   * someone edited — is left as-is.
   */
  ensureFailureCapture(e2eDir: string): void {
    const path = join(e2eDir, "fixtures.ts");
    if (!this.deps.fs.exists(path)) return;
    const src = this.deps.fs.read(path);
    const start = src.indexOf(`\n// ${FAILURE_CAPTURE_MARKER}`);
    if (start === -1) {
      if (!src.includes(FAILURE_CAPTURE_MARKER)) this.addCaptureBlock(path, src);
      return;
    }
    const endMarker = src.indexOf(FAILURE_CAPTURE_END_MARKER, start);
    if (endMarker === -1) return;
    const end = endMarker + FAILURE_CAPTURE_END_MARKER.length;
    if (!EARLIER_FAILURE_CAPTURE_BLOCKS.has(sha256(src.slice(start, end)))) return;
    this.deps.fs.write(path, src.slice(0, start) + FAILURE_CAPTURE_BLOCK + src.slice(end));
  }

  /* Appends the block to a fixtures.ts that has none, or puts it in place of the block appended without markers. */
  private addCaptureBlock(path: string, src: string): void {
    const { firstLine, length, sha256: unmarkedHash } = UNMARKED_FAILURE_CAPTURE_BLOCK;
    const at = src.indexOf(firstLine);
    if (at === -1) {
      this.deps.fs.append(path, FAILURE_CAPTURE_BLOCK);
      return;
    }
    if (sha256(src.slice(at, at + length)) !== unmarkedHash) return;
    this.deps.fs.write(path, src.slice(0, at) + FAILURE_CAPTURE_BLOCK + src.slice(at + length));
  }

  /** Keeps the Playwright session directory out of the suite PR. Idempotent. */
  ensureSessionGitignore(e2eDir: string): void {
    const path = join(e2eDir, ".gitignore");
    const line = ".auth/";
    if (!this.deps.fs.exists(path)) {
      this.deps.fs.write(path, `${line}\n`);
      return;
    }
    const src = this.deps.fs.read(path);
    if (src.split("\n").some((entry) => entry.trim() === line)) return;
    this.deps.fs.append(path, src.endsWith("\n") || src.length === 0 ? `${line}\n` : `\n${line}\n`);
  }

  /**
   * Copies the current login seed when the repo has none, and replaces a stock copy (byte-for-byte a
   * shipped seed revision). A login rewritten for the app is the repo's own and is left as-is.
   */
  ensureAuthSetup(e2eDir: string): void {
    const src = join(this.deps.seedDir, "auth.setup.ts");
    if (!this.deps.fs.exists(src)) return;
    const dest = join(e2eDir, "auth.setup.ts");
    if (!this.deps.fs.exists(dest)) {
      this.deps.fs.cp(src, dest);
      return;
    }
    const existing = this.deps.fs.read(dest);
    if (isStockAuthSetup(existing)) this.followSeed("auth.setup.ts", dest, existing);
  }

  /**
   * Replaces a stock e2e/playwright.config.ts (byte-for-byte a shipped seed revision) with the
   * current seed. Any other config is the repo's own and is never overwritten; one that lacks a
   * managed env-passthrough key gets a warning naming it.
   */
  ensurePlaywrightEnvKeys(e2eDir: string): void {
    const path = join(e2eDir, "playwright.config.ts");
    if (!this.deps.fs.exists(path)) return;
    const src = this.deps.fs.read(path);
    if (PLAYWRIGHT_CONFIG_SEED_REVISIONS.has(sha256(src))) {
      this.followSeed("playwright.config.ts", path, src);
      return;
    }
    const missing = PLAYWRIGHT_CONFIG_MANAGED_KEYS.filter((key) => !src.includes(key));
    if (missing.length === 0) return;
    console.warn(
      `[qa] ${path} is missing managed env-passthrough key(s) [${missing.join(", ")}] and is not a ` +
        `shipped seed revision — the repo owns it, so it will NOT be overwritten. Add the missing ` +
        `key(s) manually if this repo wants them.`,
    );
  }

  /* Copies the current seed `name` over the stock copy at `dest` unless it already is the current seed. */
  private followSeed(name: string, dest: string, stockCopy: string): void {
    const seed = join(this.deps.seedDir, name);
    if (!this.deps.fs.exists(seed) || this.deps.fs.read(seed) === stockCopy) return;
    this.deps.fs.cp(seed, dest);
  }

  /* Written every run from the app config, so the working copy never carries a stale login declaration; the file is gitignored by the seed and excluded from publication. */
  ensureAuthConfig(e2eDir: string): void {
    const path = join(e2eDir, E2E_AUTH_FILE);
    if (this.deps.authConfig) {
      this.deps.fs.mkdir(dirname(path));
      this.deps.fs.write(path, JSON.stringify(this.deps.authConfig, null, 2) + "\n");
      return;
    }
    if (this.deps.fs.exists(path)) this.deps.fs.remove?.(path);
  }

  private getLockHash(e2eDir: string): string | null {
    const lockPath = join(e2eDir, "package-lock.json");
    if (!this.deps.fs.exists(lockPath)) return null;
    return createHash("sha256").update(this.deps.fs.readBytes(lockPath)).digest("hex");
  }

  private isInstallCurrent(e2eDir: string): boolean {
    const nodeModules = join(e2eDir, "node_modules");
    const markerPath = join(nodeModules, ".install-hash");
    if (!this.deps.fs.exists(nodeModules) || !this.deps.fs.exists(markerPath)) return false;
    const currentHash = this.getLockHash(e2eDir);
    if (!currentHash) return false;
    try {
      return this.deps.fs.read(markerPath).trim() === currentHash;
    } catch {
      return false;
    }
  }

  private markInstallCurrent(e2eDir: string): void {
    const hash = this.getLockHash(e2eDir);
    if (!hash) return;
    this.deps.fs.mkdir(join(e2eDir, "node_modules"));
    this.deps.fs.write(join(e2eDir, "node_modules", ".install-hash"), hash);
  }

  /* `npm ci` when there is a lockfile; otherwise `npm install`. scrubEnv({ extraAllowed: /^DEV_/ }) keeps the app's DEV_* login creds while dropping the orchestrator's own secrets. A hung install must not block the sequential queue: the runner times out with timedOut:true (never rejects), so this method throws on that signal. */
  private async install(e2eDir: string, opts?: SetupOptions): Promise<void> {
    const useCi = this.deps.fs.exists(join(e2eDir, "package-lock.json"));
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
