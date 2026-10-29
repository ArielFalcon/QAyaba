/*
 * Loads and validates watched-app config. App-specific detail lives in config/, never in code.
 * ${VARS} expand from the environment so credentials never live in the repo.
 */

import { appLogger } from "../integrations/redacting-logger";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { qayabaRoot } from "../paths";
import { parse } from "yaml";
import { AppConfigSchema, type ValidatedAppConfig } from "./schemas";
import { activeEnvironment } from "../settings/active";

const ROOT = qayabaRoot();

export interface AppConfig extends ValidatedAppConfig {}

/* The app has no config file: it was never onboarded, or was deleted. */
export class AppNotFoundError extends Error {
  constructor(readonly app: string) {
    super(`config/apps/${app}.yaml not found — is the app onboarded?`);
    this.name = "AppNotFoundError";
  }
}

/* The app has a config file that cannot be turned into a valid config: it cannot be read, an env var it names is unset, the YAML does not parse or the schema rejects it. `reason` is the underlying message; `cause` keeps the original error. */
export class AppConfigInvalidError extends Error {
  constructor(readonly app: string, readonly reason: string, options?: { cause?: unknown }) {
    super(`app config invalid: '${app}': ${reason}`, options);
    this.name = "AppConfigInvalidError";
  }
}

/** The words a caller that reports instead of throwing uses for a failed load, or undefined when the failure is not about the app's config and must propagate. */
export function describeAppLoadFailure(name: string, err: unknown): string | undefined {
  if (err instanceof AppNotFoundError) return `app not found: '${name}'`;
  if (err instanceof AppConfigInvalidError) return err.message;
  return undefined;
}

/** Throws AppNotFoundError when the app has no config file and AppConfigInvalidError when the file cannot be loaded; these two are the only errors a caller is meant to tell apart. */
export function loadAppConfig(name: string, root = ROOT): ValidatedAppConfig {
  const path = join(root, "config", "apps", `${name}.yaml`);
  if (!existsSync(path)) throw new AppNotFoundError(name);
  let document: unknown;
  let config: ValidatedAppConfig;
  try {
    document = parse(expandEnv(readFileSync(path, "utf8")));
    config = AppConfigSchema.parse(document);
  } catch (err) {
    throw new AppConfigInvalidError(name, err instanceof Error ? err.message : String(err), { cause: err });
  }
  warnDroppedKeys(name, root, droppedKeyPaths(document, config));
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* The paths of the keys the schema dropped: present in the parsed YAML, absent from the validated config. Paths only, never values. */
function droppedKeyPaths(document: unknown, kept: unknown, prefix = ""): string[] {
  if (Array.isArray(document) && Array.isArray(kept)) return document.flatMap((item, i) => droppedKeyPaths(item, kept[i], `${prefix}[${i}]`));
  if (!isRecord(document) || !isRecord(kept)) return [];
  return Object.keys(document).flatMap((key) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return Object.hasOwn(kept, key) ? droppedKeyPaths(document[key], kept[key], path) : [path];
  });
}

/* A config is read on every request that names its app, so a dropped key is reported once per process, not once per read. */
const warnedKeys = new Set<string>();

function warnDroppedKeys(app: string, root: string, paths: readonly string[]): void {
  for (const key of paths) {
    const id = `${root}\0${app}\0${key}`;
    if (warnedKeys.has(id)) continue;
    warnedKeys.add(id);
    appLogger.warn(`[qa] app config '${app}': unknown key '${key}' is ignored (the schema does not declare it; a typo falls back to the default)`, { app, key });
  }
}

/* An unset ${VAR} silently un-watches an app — surface it as an error, not a malformed-YAML skip. */
function logConfigSkip(file: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (/unset env var/.test(msg)) {
    appLogger.error(
      `[qa] CONFIG ERROR: ${file} references an unset env var — this app will NOT be watched ` +
        `(no webhooks processed for it) until the variable is set in the environment: ${msg}`,
    );
  } else {
    appLogger.warn(`[qa] skipping malformed config ${file}: ${msg}`);
  }
}

export type RepoRole = "primary" | "service";

export interface RepoMatch {
  app: AppConfig;
  role: RepoRole;
}


export function listAppConfigs(root = ROOT): AppConfig[] {
  const dir = join(root, "config", "apps");
  if (!existsSync(dir)) return [];
  const out: AppConfig[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".yaml") || f.startsWith("example")) continue;
    try {
      out.push(loadAppConfig(f.replace(/\.yaml$/, ""), root));
    } catch (err) {
      logConfigSkip(f, err);
    }
  }
  return out;
}

export function expandEnv(s: string, env: Record<string, string | undefined> = activeEnvironment()): string {
  /* Match any shell-style identifier (not uppercase-only) so a mis-cased ${myToken} fails as unset. */
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
    const val = env[key];
    if (val === undefined) throw new Error(`config references unset env var \${${key}}`);
    return val;
  });
}
