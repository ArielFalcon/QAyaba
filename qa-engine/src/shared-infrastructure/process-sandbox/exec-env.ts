/* The environment of a sandboxed child, built from an explicit allowlist per profile. scrubEnv removes the orchestrator's known secrets from a copy of its own environment; here the child starts from nothing and receives only what its profile names, so a secret the orchestrator gains tomorrow is absent from every child without anyone listing it. Pure: the base environment is handed in (qa-engine never reads process.env outside scrub-env.ts), and nothing here touches the filesystem. */

import { join } from "node:path";
import { sandboxSpawnOptions, type Sandbox } from "./sandbox.ts";
import { scrubEnvFrom } from "./scrub-env.ts";

/* offline: runs agent code with no network (tsc, eslint, `playwright test --list`).
   suite: runs the agent's specs against DEV with the saved session, never the account.
   login: the profile that carries the test account (the auth setup and the login discovery); a suite gets it only when its app opted in (e2e.specCredentials: account).
   install: package-manager and toolchain work that reaches registries only (npm ci, mvn, pip, cargo, go). */
export const SANDBOX_PROFILES = ["offline", "suite", "login", "install"] as const;
export type SandboxProfile = (typeof SANDBOX_PROFILES)[number];

export interface StagedAuth {
  storageState?: string;
  clientCert?: string;
  certPass?: string;
}

export interface ExecEnvInput {
  profile: SandboxProfile;
  /* The environment the orchestrator runs in. Only the names allowlisted below are read from it. */
  base: NodeJS.ProcessEnv;
  sandbox: Sandbox | null;
  workDir: string;
  gateCreds?: { user: string; pass: string };
  /* The session and certificate copies the launcher staged inside the work dir. */
  staged?: StagedAuth;
  /* The account, honored by the login profile alone. */
  account?: { user: string; pass: string };
  /* The account handed to a SUITE, only for an app that opted in (e2e.specCredentials: account): its specs log in themselves. Never to offline or install. */
  suiteAccount?: { user: string; pass: string };
  extraEnv?: Record<string, string>;
}

/* The names every profile may read from the base environment. */
const COMMON_FROM_BASE = ["PATH", "LANG", "LC_ALL", "TZ", "PLAYWRIGHT_BROWSERS_PATH"] as const;

/* What a caller may add: the Playwright contract and the capture directories. DEV_*, QA_* secrets and loader variables (NODE_OPTIONS) cannot be named. */
const EXTRA_ENV_ALLOWED = /^(?:PW_[A-Z0-9_]+|PLAYWRIGHT_JSON_OUTPUT_NAME|QA_FAILURE_CAPTURE_DIR|QA_FAULT_INJECT)$/;

/* The names the launcher owns outside a login: a caller cannot point a suite at another session. */
const LAUNCHER_MANAGED = new Set(["PW_STORAGE_STATE", "PW_CLIENT_CERT_PATH"]);

/* Variables an install must not inherit even though the package-manager family allows them. */
const INSTALL_DROP = ["NODE_OPTIONS", "NODE_PATH", "SSH_AUTH_SOCK"] as const;

function insideWorkDir(path: string, workDir: string): boolean {
  const root = workDir.endsWith("/") ? workDir : `${workDir}/`;
  return path.startsWith(root) && !path.includes("/../");
}

function checkedExtra(input: ExecEnvInput): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.extraEnv ?? {})) {
    if (!EXTRA_ENV_ALLOWED.test(key)) throw new Error(`environment variable ${key} is not allowed for a sandboxed child`);
    if (LAUNCHER_MANAGED.has(key)) {
      if (input.profile !== "login") throw new Error(`environment variable ${key} is managed by the launcher and is not allowed for the ${input.profile} profile`);
      if (key === "PW_STORAGE_STATE" && !insideWorkDir(value, input.workDir)) throw new Error(`the session file of a login must be inside the run's work dir, got ${value}`);
    }
    extra[key] = value;
  }
  return extra;
}

export function buildExecEnv(input: ExecEnvInput): Record<string, string> {
  const raw: Record<string, string> = {};
  if (input.profile === "install") {
    Object.assign(raw, scrubEnvFrom(input.base, { quiet: true }));
    for (const key of INSTALL_DROP) delete raw[key];
  } else {
    for (const key of COMMON_FROM_BASE) {
      const value = input.base[key];
      if (value !== undefined) raw[key] = value;
    }
  }
  /* `npx` and `npm` ask the registry whether a newer npm exists. That is a host the child contacts for no reason of its own: it is refused (and listed as denied) under the egress filter, which would read as evidence against whatever the child was doing, and it is a call out on every spawn where the filter lets it through. */
  raw.npm_config_update_notifier = "false";
  /* Kept as the base spells it so the sandbox rebase below can move paths under it onto the sandbox home. */
  raw.HOME = input.base.HOME ?? "";
  const tmp = join(input.workDir, "tmp");
  raw.TMPDIR = tmp;
  raw.TMP = tmp;
  raw.TEMP = tmp;

  Object.assign(raw, checkedExtra(input));

  if (input.profile === "suite" || input.profile === "login") {
    if (input.gateCreds) {
      raw.DEV_ENV_USER = input.gateCreds.user;
      raw.DEV_ENV_PASS = input.gateCreds.pass;
    }
    if (input.staged?.clientCert) {
      raw.PW_CLIENT_CERT_PATH = input.staged.clientCert;
      if (input.staged.certPass !== undefined) raw.DEV_CLIENT_CERT_PASS = input.staged.certPass;
    }
    if (input.profile === "suite" && input.staged?.storageState) raw.PW_STORAGE_STATE = input.staged.storageState;
  }
  const account = input.profile === "login" ? input.account : input.profile === "suite" ? input.suiteAccount : undefined;
  if (account) {
    raw.DEV_TEST_USER = account.user;
    raw.DEV_TEST_PASS = account.pass;
  }
  return sandboxSpawnOptions(raw, input.sandbox, join(input.workDir, "home")).env;
}
