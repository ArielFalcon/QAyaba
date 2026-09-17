/* E2E project setup: bootstrap the seed if missing, then install deps. This adapter never reads env — seedDir is injected. FAILURE_CAPTURE_BLOCK is data appended into the watched app's fixtures (runs in that app's Playwright process), not code this module executes. */
import { createHash } from "node:crypto";
import { existsSync, cpSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";

export const DEFAULT_E2E_INSTALL_TIMEOUT_MS = 600_000;

export const FAILURE_CAPTURE_MARKER = ">>> qa-failure-capture (system-owned: do not edit) >>>";

export const PLAYWRIGHT_CONFIG_SEED_MARKER = "qa-playwright-config-seed";

const PLAYWRIGHT_CONFIG_MANAGED_KEYS = ["actionTimeout", "testIdAttribute"] as const;

export const FAILURE_CAPTURE_BLOCK = `
let errorResponses = [];
/* Browser console error-level entries and uncaught pageerror exceptions for the current test. Reset per-test so a reused page never cross-attributes a prior test. Diagnostic signal only — never blocks or masks a generated-test defect. */
let runtimeErrors = [];
test.beforeEach(async ({ page }) => {
  if (!process.env.QA_FAILURE_CAPTURE_DIR) return;
  errorResponses = [];
  runtimeErrors = [];
  try {
    page.on('response', (r) => {
      try { const s = r.status(); if (s >= 400) errorResponses.push({ url: r.url(), status: s, resourceType: r.request().resourceType() }); } catch {}
    });
  } catch {}
  try {
    page.on('console', (msg) => {
      try {
        if (msg.type() !== 'error') return;
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
  if (!dir) return;
  if (testInfo.status === testInfo.expectedStatus) return;
  try {
    const { writeFileSync } = await import("node:fs");
    const { join, basename } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const yaml = await page.locator("body").ariaSnapshot();
    const title = testInfo.titlePath.filter(Boolean).slice(1).join(" › ");
    const project = testInfo.project.name;
    const file = basename(testInfo.file ?? "");
    const hash = createHash("sha1").update(\`\${file}/\${title}\`).digest("hex").slice(0, 12);
    const safeProject = project.replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
    const finalUrl = page.url();
    let httpStatus = undefined;
    try {
      let finalUrlOrigin = '';
      try { finalUrlOrigin = new URL(finalUrl).origin; } catch {}
      const FOREGROUND = new Set(['document', 'fetch', 'xhr']);
      const BACKGROUND = new Set(['ping', 'beacon', 'image', 'stylesheet', 'font', 'media']);
      const survivors = errorResponses.filter((e) => {
        if (e.status < 500 || e.status > 599) return false;
        if (BACKGROUND.has(e.resourceType)) return false;
        if (!FOREGROUND.has(e.resourceType)) return false;
        try {
          const eOrigin = new URL(e.url).origin;
          return eOrigin === finalUrlOrigin;
        } catch { return false; }
      });
      if (survivors.length > 0) httpStatus = survivors[survivors.length - 1].status;
    } catch {}
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
