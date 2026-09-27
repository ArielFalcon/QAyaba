/* E2E project setup: bootstrap the seed if missing, then install deps. This adapter never reads env — seedDir is injected. FAILURE_CAPTURE_BLOCK is data appended into the watched app's fixtures (runs in that app's Playwright process), not code this module executes. */
import { createHash } from "node:crypto";
import { existsSync, cpSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";

export const DEFAULT_E2E_INSTALL_TIMEOUT_MS = 600_000;

export const FAILURE_CAPTURE_MARKER = ">>> qa-failure-capture (system-owned: do not edit) >>>";

export const PLAYWRIGHT_CONFIG_SEED_MARKER = "qa-playwright-config-seed";

/* First line of every auth.setup.ts seed revision; the agent drops it when it rewrites the login for the app. */
export const AUTH_SETUP_SEED_MARKER = "/* qa-auth-setup-seed */";

const PLAYWRIGHT_CONFIG_MANAGED_KEYS = ["actionTimeout", "testIdAttribute", "storageState", "PW_AUTH_SETUP"] as const;

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
let errorResponses = [];
// Feature B (app-defect detection): browser console \`error\`-level entries and uncaught \`pageerror\`
// exceptions observed during the current test. Reset per-test (mirrors errorResponses) so a reused
// page never cross-attributes a PRIOR test's runtime errors to the current one. Best-effort: the
// orchestrator's classifyRuntimeErrors (src/qa/failure-adjudicator.ts) turns this into a diagnostic
// signal ONLY — it never blocks or masks a real generated-test defect (see that module's doc).
let runtimeErrors = [];
test.beforeEach(async ({ page }) => {
  if (!process.env.QA_FAILURE_CAPTURE_DIR) return; // no-op when capture is disabled (zero overhead)
  errorResponses = [];                               // reset unconditionally so reused pages never cross-attribute
  runtimeErrors = [];                                 // Feature B: same per-test reset discipline
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
    // D1/D2: compute finalUrl (sync, always available in afterEach) and the attributed httpStatus
    // via the D2 heuristic (5xx-only, resource-type-gated, same-origin correlated, last).
    // (Path-family intentionally omitted: in a SPA the finalUrl is the UI route (e.g. /orders) while
    // the causing 5xx is the API call (e.g. /api/orders) — different path segments — so path-family
    // would drop legitimate API 5xxs; same-origin is the correct, not-too-tight correlation.)
    const finalUrl = page.url();
    let httpStatus = undefined;
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
      if (survivors.length > 0) httpStatus = survivors[survivors.length - 1].status; // last survivor
    } catch {}
    // Feature B: dedupe (same type+text pair collapses to one entry — a repeated framework error
    // firing on every change-detection cycle would otherwise flood the dump), cap at ~15 entries
    // (the orchestrator only needs enough to classify, not an exhaustive log), and truncate each
    // entry's text to ~200 chars (the classifier only needs the first line/signature, not a full
    // stack). Best-effort: any failure here still lets the rest of the dump (yaml/finalUrl/httpStatus)
    // write normally.
    let dedupedRuntimeErrors = [];
    try {
      const RUNTIME_ERRORS_CAP = 15;
      const RUNTIME_ERROR_TEXT_CAP = 200;
      const seen = new Set();
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
}

export const nodeFsDeps: SetupAdapterFsDeps = {
  exists: existsSync,
  cp: (src, dest, opts) => cpSync(src, dest, opts),
  read: (path) => readFileSync(path, "utf8"),
  readBytes: (path) => readFileSync(path),
  write: writeFileSync,
  append: appendFileSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
};

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

  ensureFailureCapture(e2eDir: string): void {
    const path = join(e2eDir, "fixtures.ts");
    if (!this.deps.fs.exists(path)) return;
    const src = this.deps.fs.read(path);
    if (src.includes(FAILURE_CAPTURE_MARKER)) return;
    this.deps.fs.append(path, FAILURE_CAPTURE_BLOCK);
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
   * Copies the current login seed when the repo has none, and replaces a stock copy (seed marker
   * still on its first line) left by an earlier seed revision. An app-owned auth.setup.ts — the
   * agent drops the marker when it rewrites the login — is left as-is.
   */
  ensureAuthSetup(e2eDir: string): void {
    const src = join(this.deps.seedDir, "auth.setup.ts");
    if (!this.deps.fs.exists(src)) return;
    const dest = join(e2eDir, "auth.setup.ts");
    if (this.deps.fs.exists(dest)) {
      const existing = this.deps.fs.read(dest);
      if (!existing.startsWith(AUTH_SETUP_SEED_MARKER)) return;
      if (existing === this.deps.fs.read(src)) return;
    }
    this.deps.fs.cp(src, dest);
  }

  ensurePlaywrightEnvKeys(e2eDir: string): void {
    const path = join(e2eDir, "playwright.config.ts");
    if (!this.deps.fs.exists(path)) return;
    const src = this.deps.fs.read(path);
    const hasAllManagedKeys = PLAYWRIGHT_CONFIG_MANAGED_KEYS.every((key) => src.includes(key));
    if (hasAllManagedKeys) return;
    if (!src.includes(PLAYWRIGHT_CONFIG_SEED_MARKER)) {
      const missing = PLAYWRIGHT_CONFIG_MANAGED_KEYS.filter((key) => !src.includes(key));
      console.warn(
        `[qa] ${path} is missing managed env-passthrough key(s) [${missing.join(", ")}] but carries no ` +
          `seed ownership marker — the config has been customized (or predates the marker), so it will ` +
          `NOT be overwritten. Add the missing key(s) manually if this repo wants them.`,
      );
      return;
    }
    this.deps.fs.cp(join(this.deps.seedDir, "playwright.config.ts"), path);
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
