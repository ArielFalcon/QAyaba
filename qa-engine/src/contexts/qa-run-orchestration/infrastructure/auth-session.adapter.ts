/*
 * The one auth implementation. form spawns the Playwright setup project; mtls decodes a PKCS#12.
 * Both leave files under `authDir` — an orchestrator-only directory supplied by the composition
 * root (e.g. <dataDir>/auth/<app>/), NEVER under the watched-repo mirror (specDir/req.specDir).
 * The agents container mounts the mirrors volume (read+bash) but not qa-data, so anything written
 * under the mirror would be agent-visible; authDir lives outside it. authSessionEnv (the sibling
 * env-overlay reader) and every execute/DOM-capture caller must be given this SAME authDir.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isStockAuthSetup } from "../../../shared-infrastructure/e2e-seed/auth-setup-seed.ts";
import { AUTH_MATERIAL_FILES } from "../../../shared-infrastructure/process-sandbox/auth-session-env.ts";
import { ConfinedPathError, MAX_SPEC_SOURCE_BYTES, readOwnedSpecFile } from "../../../shared-infrastructure/spec-path-confinement.ts";
import { MAX_STORAGE_STATE_BYTES, activeRunSecretScope, redactByValue, registerSessionSecretsFromStorageState } from "../../../shared-infrastructure/run-secret-redaction.ts";
import { partitionRoutes } from "../../../shared-kernel/route-capturability.ts";
import { AUTH_RESOLUTION_METHOD, type AuthDeclaration, type AuthSession, type AuthSessionPort, type AuthSessionRequest } from "../application/ports/auth-session.port.ts";
import { AuthPreconditionError } from "../domain/auth-precondition.ts";
import { LOGIN_STATUS, classifyLoginEvidence, renderLoginEvidence, type LoginOutcome } from "../domain/helpers/login-evidence.ts";
import type { LoginDiscoveryInput, LoginDiscoveryResult } from "./login-discovery/login-discovery.runner.ts";

export interface AuthSessionSpawnResult {
  exitCode: number;
  logs: string;
}

/** A route the app's context map lists. */
export interface ContextRoute {
  path: string;
}

/** The part of the app's context map that discovery reads. */
export interface ContextRouteMap {
  routes: ReadonlyArray<ContextRoute>;
}

/**
 * The structural login attempt that runs before the stock seed. It comes as one object so that the
 * redaction cannot be left out when discovery is wired: whatever leaves as a note passes through it.
 */
export interface AuthDiscoveryDeps {
  discoverLogin(input: LoginDiscoveryInput, signal?: AbortSignal): Promise<LoginDiscoveryResult>;
  /** The shell's redaction of anything leaving the system, applied to the note after the exact-value scrub. */
  redact(text: string): string;
  /** The app's context map, read from the suite directory, for the gated routes the ladder tries after the root. */
  loadContextMap?(specDir: string): ContextRouteMap | undefined;
  /** Milliseconds since some fixed point; injected so a test reads a duration without real time. */
  now?(): number;
}

export interface AuthSessionAdapterDeps {
  env: NodeJS.ProcessEnv;
  /** Orchestrator-only directory (outside the mirror) auth material is written to and read from. */
  authDir: string;
  /** The app's test-id attribute; the setup project resolves locators with it as the suite does. */
  testIdAttribute?: string;
  /** The action auto-wait bound (ms, as the seed config reads it); a slower DEV can widen it. */
  actionTimeoutMs?: string;
  /** Absent: the login is the stock seed alone, as it was before discovery existed. */
  discovery?: AuthDiscoveryDeps;
  /** The child's variables (PW_*, and the account for the launcher to hand to the login profile): never a full environment. */
  spawnSetup(specDir: string, env: Record<string, string>, signal?: AbortSignal): Promise<AuthSessionSpawnResult>;
  /**
   * Where a login child writes the session it produces: a directory the sandbox uid can write in, and the root the
   * strict reader walks from. The orchestrator copies a confirmed session from there into `authDir`, which no child
   * can open. Absent: the child writes straight into `authDir`, as a login run as the orchestrator did.
   */
  loginStaging?(): { dir: string; root: string };
}

/* The env names the seed playwright.config.ts reads for the test-id attribute and the action auto-wait bound; the execute and DOM-capture spawns pass the same pair. */
export const AUTH_SETUP_ENV = {
  testIdAttribute: "PW_TEST_ID_ATTRIBUTE",
  actionTimeoutMs: "PW_ACTION_TIMEOUT_MS",
} as const;

/* The env names of the DEV gate's HTTP Basic credentials and of the client certificate's passphrase: the contract of the DOM capture and the login (dom-snapshot.ts, auth-session-env.ts), not an app's. */
const DEV_GATE_ENV_NAMES = ["DEV_ENV_USER", "DEV_ENV_PASS", "DEV_CLIENT_CERT_PASS"] as const;

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/* The login the stock seed ships as, in the spec directory. */
const AUTH_SETUP_FILE = "auth.setup.ts";

/* What a submit that could not be confirmed leaves before execute: no seed runs after it, so there is nothing of the seed's to say. */
const UNCONFIRMED_LOGIN_MESSAGE = "auth setup was not retried: a login was already submitted and its outcome could not be confirmed";

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
    this.registerAccountSecrets(req.auth);
    if (!req.auth) return { unauthored: false };
    const session = req.auth.kind === "mtls" ? this.materializeCert(req) : await this.runFormSetup(req, signal);
    /* The session the login produced is known only now: its cookie and storage values are secrets of the run from here on. */
    if (session.storageStatePath) registerSessionSecretsFromStorageState(this.deps.authDir, AUTH_MATERIAL_FILES.storageState);
    return session;
  }

  /* The secrets of the account, by value, into the run this prepare is part of (a no-op outside a run): the login's, the DEV gate's and the certificate's passphrase. Registered before anything can fail, so a login that throws has still named them. */
  private registerAccountSecrets(auth: AuthDeclaration | undefined): void {
    const declared = [auth?.usernameEnv, auth?.passwordEnv, auth?.certPassEnv, ...DEV_GATE_ENV_NAMES];
    activeRunSecretScope()?.addAccountSecrets(declared.map((name) => (name === undefined ? undefined : this.deps.env[name])));
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

    const setup = this.readSetup(req.specDir);
    const stock = setup.stock;
    mkdirSync(this.deps.authDir, { recursive: true, mode: 0o700 });
    const storageStatePath = join(this.deps.authDir, AUTH_MATERIAL_FILES.storageState);
    /* Where the child writes the session: its own staging directory when there is one. */
    const staging = this.deps.loginStaging?.();
    const childStatePath = staging ? join(staging.dir, AUTH_MATERIAL_FILES.storageState) : storageStatePath;
    /* The account alone: the launcher adds the DEV gate's credentials from the run's scope and every other variable from the login profile's allowlist. */
    const accountEnv: Record<string, string> = { DEV_TEST_USER: user, DEV_TEST_PASS: pass };
    /* Discovery is for the stock seed only: an app's own login script is its own recipe. */
    if (stock && this.deps.discovery) {
      const found = await this.discover(req, user, pass, accountEnv, storageStatePath, childStatePath, staging?.root, this.deps.discovery, signal);
      if ("session" in found) return found.session;
      /* A submit already went out: the seed must not send another. */
      if (found.attempted) {
        if (req.phase === "pre-generate") return { unauthored: true };
        throw new Error(UNCONFIRMED_LOGIN_MESSAGE);
      }
    }
    const childEnv: Record<string, string> = {
      ...accountEnv,
      PW_BASE_URL: req.baseUrl,
      /* Tells the setup project (auth.setup.ts) to write storageState here — outside the mirror —
         instead of its relative, mirror-local ".auth/user.json" fallback. */
      PW_STORAGE_STATE: childStatePath,
      /* The seed config defines its setup project only for this login run; a suite run passes no
         --project and must not execute the login as a case. */
      PW_AUTH_SETUP: "1",
    };
    if (this.deps.testIdAttribute) childEnv[AUTH_SETUP_ENV.testIdAttribute] = this.deps.testIdAttribute;
    if (this.deps.actionTimeoutMs) childEnv[AUTH_SETUP_ENV.actionTimeoutMs] = this.deps.actionTimeoutMs;

    const result = await this.deps.spawnSetup(req.specDir, childEnv, signal);
    const wrote = this.takeSession(childStatePath, storageStatePath, staging?.root);
    if (result.exitCode === 0 && wrote) {
      return { storageStatePath, unauthored: false, ...(setup.sha256 !== undefined && !stock ? { setupSha256: setup.sha256 } : {}) };
    }
    if (stock && req.phase === "pre-generate") {
      return { unauthored: true };
    }
    const detail = redactByValue(result.logs.trim()) || `exit ${result.exitCode}`;
    throw new Error(`auth setup failed: ${detail.slice(0, 4000)}`);
  }

  /*
   * One structural login attempt. A confirmed login is the session; a positively evidenced failure
   * is a typed error carrying a note free of the account; anything else says whether a credential
   * was submitted. Whatever the child wrote as a session is removed unless the login was confirmed.
   */
  private async discover(
    req: AuthSessionRequest,
    user: string,
    pass: string,
    env: Record<string, string>,
    storageStatePath: string,
    childStatePath: string,
    stagingRoot: string | undefined,
    discovery: AuthDiscoveryDeps,
    signal?: AbortSignal,
  ): Promise<{ session: AuthSession } | { attempted: boolean }> {
    const now = discovery.now ?? Date.now;
    const started = now();
    const actionTimeoutMs = Number(this.deps.actionTimeoutMs);
    const result = await discovery.discoverLogin(
      {
        specDir: req.specDir,
        baseUrl: req.baseUrl,
        routes: this.gatedRoutes(req.specDir, discovery),
        storageStatePath: childStatePath,
        env,
        ...(req.auth?.loginPath ? { loginPath: req.auth.loginPath } : {}),
        ...(Number.isFinite(actionTimeoutMs) && actionTimeoutMs > 0 ? { actionTimeoutMs } : {}),
      },
      signal,
    );
    const outcome: LoginOutcome = "crashed" in result ? { status: LOGIN_STATUS.INCONCLUSIVE, attempted: result.attempted } : classifyLoginEvidence(result);
    if (outcome.status === LOGIN_STATUS.AUTHENTICATED && this.takeSession(childStatePath, storageStatePath, stagingRoot)) {
      return { session: { storageStatePath, unauthored: false, resolution: { method: AUTH_RESOLUTION_METHOD.DISCOVERY, ms: now() - started } } };
    }
    rmSync(storageStatePath, { force: true });
    rmSync(childStatePath, { force: true });
    if (outcome.status === LOGIN_STATUS.FAILED && !("crashed" in result)) {
      throw new AuthPreconditionError(outcome.kind, discovery.redact(renderLoginEvidence(outcome.kind, result, [user, pass])), now() - started);
    }
    /* An abort is no reason to start a second login; a confirmed login whose session is missing was still a submit. */
    return { attempted: outcome.status !== LOGIN_STATUS.INCONCLUSIVE || outcome.attempted || signal?.aborted === true };
  }

  /* The app's own routes from its context map that a browser can open, in the map's order and without repeats. */
  private gatedRoutes(specDir: string, discovery: AuthDiscoveryDeps): string[] {
    const paths = discovery.loadContextMap?.(specDir)?.routes.map((route) => route.path) ?? [];
    return partitionRoutes(paths).capturable;
  }

  /* Whether the login left a session, now at `storageStatePath` with mode 0600. A session the child wrote into its own staging directory is read strictly (no link, a regular file, under a cap: the child chose what is there), copied into the auth directory and removed from staging; one written straight into the auth directory is only locked down. */
  private takeSession(childStatePath: string, storageStatePath: string, stagingRoot: string | undefined): boolean {
    if (childStatePath === storageStatePath) {
      if (!existsSync(storageStatePath)) return false;
      chmodSync(storageStatePath, 0o600);
      return true;
    }
    if (stagingRoot === undefined) return false;
    let read;
    try {
      read = readOwnedSpecFile({ mirrorDir: stagingRoot, specDir: stagingRoot }, relative(stagingRoot, childStatePath), MAX_STORAGE_STATE_BYTES);
    } catch {
      return false;
    }
    rmSync(childStatePath, { force: true });
    if (!("bytes" in read)) return false;
    writeFileSync(storageStatePath, read.bytes, { mode: 0o600 });
    chmodSync(storageStatePath, 0o600);
    return true;
  }

  private clearMaterial(): void {
    for (const file of Object.values(AUTH_MATERIAL_FILES)) {
      rmSync(join(this.deps.authDir, file), { force: true });
    }
  }

  /* The same predicate setup uses to decide whether it may replace the file: only a shipped seed is stock, and a file that is not there is the seed to come. It is asked after the agent has run, about a file in a directory the agent writes into, so the file is read strictly: one the read cannot vouch for (a link, a named pipe, a directory, one over the cap) fails the login, aloud, as an infra-error; it is never waited on, followed or taken for stock or for the app's own. A file that is only unreadable fails the login with the failure itself. The hash is of the bytes read, so it names the file that was judged, whatever the agent does with the path afterwards. */
  private readSetup(specDir: string): { stock: boolean; sha256?: string } {
    if (!existsSync(specDir)) return { stock: true };
    const read = readOwnedSpecFile({ mirrorDir: specDir, specDir }, AUTH_SETUP_FILE, MAX_SPEC_SOURCE_BYTES);
    if ("absent" in read) return { stock: true };
    if ("reason" in read) throw new ConfinedPathError(join(specDir, AUTH_SETUP_FILE), read.reason);
    return { stock: isStockAuthSetup(read.bytes.toString("utf8")), sha256: createHash("sha256").update(read.bytes).digest("hex") };
  }
}
