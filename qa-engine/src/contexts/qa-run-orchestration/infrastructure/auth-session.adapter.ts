/*
 * The one auth implementation. form spawns the Playwright setup project; mtls decodes a PKCS#12.
 * Both leave files under `authDir` — an orchestrator-only directory supplied by the composition
 * root (e.g. <dataDir>/auth/<app>/), NEVER under the watched-repo mirror (specDir/req.specDir).
 * The agents container mounts the mirrors volume (read+bash) but not qa-data, so anything written
 * under the mirror would be agent-visible; authDir lives outside it. authSessionEnv (the sibling
 * env-overlay reader) and every execute/DOM-capture caller must be given this SAME authDir.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isStockAuthSetup } from "../../../shared-infrastructure/e2e-seed/auth-setup-seed.ts";
import { AUTH_MATERIAL_FILES } from "../../../shared-infrastructure/process-sandbox/auth-session-env.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import type { AuthSession, AuthSessionPort, AuthSessionRequest } from "../application/ports/auth-session.port.ts";

export interface AuthSessionSpawnResult {
  exitCode: number;
  logs: string;
}

export interface AuthSessionAdapterDeps {
  env: NodeJS.ProcessEnv;
  /** Orchestrator-only directory (outside the mirror) auth material is written to and read from. */
  authDir: string;
  /** The app's test-id attribute; the setup project resolves locators with it as the suite does. */
  testIdAttribute?: string;
  /** The action auto-wait bound (ms, as the seed config reads it); a slower DEV can widen it. */
  actionTimeoutMs?: string;
  spawnSetup(specDir: string, env: Record<string, string>, signal?: AbortSignal): Promise<AuthSessionSpawnResult>;
}

/* The env names the seed playwright.config.ts reads for the test-id attribute and the action auto-wait bound; the execute and DOM-capture spawns pass the same pair. */
export const AUTH_SETUP_ENV = {
  testIdAttribute: "PW_TEST_ID_ATTRIBUTE",
  actionTimeoutMs: "PW_ACTION_TIMEOUT_MS",
} as const;

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class AuthSessionAdapter implements AuthSessionPort {
  constructor(private readonly deps: AuthSessionAdapterDeps) {}

  async prepare(req: AuthSessionRequest, signal?: AbortSignal): Promise<AuthSession> {
    /*
     * Every prepare starts from an empty authDir. authSessionEnv injects whatever material is
     * there, so a session or certificate left by an earlier run — or by an earlier auth
     * declaration — must never survive into this one; a setup that exits 0 without writing then
     * reads as the failure it is, not as yesterday's session.
     */
    this.clearMaterial();
    if (!req.auth) return { unauthored: false };
    if (req.auth.kind === "mtls") return this.materializeCert(req);
    return this.runFormSetup(req, signal);
  }

  private materializeCert(req: AuthSessionRequest): AuthSession {
    const certEnv = req.auth?.certEnv;
    const certPassEnv = req.auth?.certPassEnv;
    if (!certEnv || !certPassEnv) {
      throw new Error("auth.kind mtls requires certEnv and certPassEnv");
    }
    const raw = this.deps.env[certEnv];
    if (!raw || raw.length % 4 !== 0 || !B64.test(raw)) {
      throw new Error(`auth certificate env ${certEnv} is missing or not base64`);
    }
    if (this.deps.env[certPassEnv] === undefined) {
      throw new Error(`auth certificate passphrase env ${certPassEnv} is missing`);
    }
    const dir = this.deps.authDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const certPath = join(dir, AUTH_MATERIAL_FILES.clientCert);
    writeFileSync(certPath, Buffer.from(raw, "base64"), { mode: 0o600 });
    chmodSync(certPath, 0o600);
    const passPath = join(dir, AUTH_MATERIAL_FILES.certPass);
    writeFileSync(passPath, this.deps.env[certPassEnv] ?? "", { mode: 0o600 });
    chmodSync(passPath, 0o600);
    return { clientCertPath: certPath, unauthored: false };
  }

  private async runFormSetup(req: AuthSessionRequest, signal?: AbortSignal): Promise<AuthSession> {
    const usernameEnv = req.auth?.usernameEnv;
    const passwordEnv = req.auth?.passwordEnv;
    if (!usernameEnv || !passwordEnv) {
      throw new Error("auth.kind form requires usernameEnv and passwordEnv");
    }
    const user = this.deps.env[usernameEnv];
    const pass = this.deps.env[passwordEnv];
    if (!user || !pass) {
      throw new Error(`auth.kind form requires ${usernameEnv} and ${passwordEnv}`);
    }

    const stock = this.isStock(req.specDir);
    mkdirSync(this.deps.authDir, { recursive: true, mode: 0o700 });
    const storageStatePath = join(this.deps.authDir, AUTH_MATERIAL_FILES.storageState);
    const childEnv: Record<string, string> = {
      ...scrubEnv({ extraAllowed: /^DEV_/ }),
      PW_BASE_URL: req.baseUrl,
      DEV_TEST_USER: user,
      DEV_TEST_PASS: pass,
      /* Tells the setup project (auth.setup.ts) to write storageState here — outside the mirror —
         instead of its relative, mirror-local ".auth/user.json" fallback. */
      PW_STORAGE_STATE: storageStatePath,
      /* The seed config defines its setup project only for this login run; a suite run passes no
         --project and must not execute the login as a case. */
      PW_AUTH_SETUP: "1",
    };
    if (this.deps.testIdAttribute) childEnv[AUTH_SETUP_ENV.testIdAttribute] = this.deps.testIdAttribute;
    if (this.deps.actionTimeoutMs) childEnv[AUTH_SETUP_ENV.actionTimeoutMs] = this.deps.actionTimeoutMs;
    if (this.deps.env.DEV_ENV_USER) {
      childEnv.DEV_ENV_USER = this.deps.env.DEV_ENV_USER;
      childEnv.DEV_ENV_PASS = this.deps.env.DEV_ENV_PASS ?? "";
    }

    const result = await this.deps.spawnSetup(req.specDir, childEnv, signal);
    const wrote = existsSync(storageStatePath);
    if (result.exitCode === 0 && wrote) {
      chmodSync(storageStatePath, 0o600);
      return { storageStatePath, unauthored: false };
    }
    if (stock && req.phase === "pre-generate") {
      return { unauthored: true };
    }
    const detail = result.logs.trim() || `exit ${result.exitCode}`;
    throw new Error(`auth setup failed: ${detail.slice(0, 4000)}`);
  }

  private clearMaterial(): void {
    for (const file of Object.values(AUTH_MATERIAL_FILES)) {
      rmSync(join(this.deps.authDir, file), { force: true });
    }
  }

  /* The same predicate setup uses to decide whether it may replace the file: only a shipped seed is stock. */
  private isStock(specDir: string): boolean {
    const path = join(specDir, "auth.setup.ts");
    return !existsSync(path) || isStockAuthSetup(readFileSync(path, "utf8"));
  }
}
