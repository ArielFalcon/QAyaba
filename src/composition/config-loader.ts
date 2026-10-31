/*
 * Loads and validates watched-app config. App-specific detail lives in config/, never in code.
 * ${VARS} expand from the environment so credentials never live in the repo.
 */

import { appLogger } from "../telemetry/redacting-logger";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { qayabaRoot } from "../settings/paths";
import { parse } from "yaml";
import { AppConfigSchema, describeAppConfigError, expandEnv, type ValidatedAppConfig } from "@contexts/app-catalog/application/index";
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
  try {
    return AppConfigSchema.parse(parse(expandEnv(readFileSync(path, "utf8"), activeEnvironment())));
  } catch (err) {
    throw new AppConfigInvalidError(name, describeAppConfigError(err), { cause: err });
  }
}

/* An app whose config file did not load: the file (relative to the root) and the reason, which names the key when a key is at fault. */
export interface NotLoadedApp {
  readonly app: string;
  readonly file: string;
  readonly reason: string;
}

export interface AppConfigScan {
  readonly loaded: AppConfig[];
  readonly notLoaded: NotLoadedApp[];
}

/* The last reason reported for each file that did not load, so a config read on every request reports a skip once, not once per read. A file that loads, or is gone, is forgotten and reports again if it breaks again. */
const reportedSkips = new Map<string, string>();

function reportSkips(root: string, notLoaded: readonly NotLoadedApp[]): void {
  const now = new Set(notLoaded.map((entry) => `${root}\0${entry.file}`));
  for (const key of reportedSkips.keys()) if (key.startsWith(`${root}\0`) && !now.has(key)) reportedSkips.delete(key);
  for (const { app, file, reason } of notLoaded) {
    const key = `${root}\0${file}`;
    if (reportedSkips.get(key) === reason) continue;
    reportedSkips.set(key, reason);
    appLogger.error(`[qa] CONFIG ERROR: ${file} is not loaded — app '${app}' will NOT be watched (no webhooks processed for it) until it is fixed: ${reason}`, { app, file });
  }
}

/** Every app under config/apps: the configs that loaded and, for each file that did not, the app, the file and the reason. A file that fails is skipped and the others still load; the skip is an error line (once per reason) and is listed here for /api/health. */
export function scanAppConfigs(root = ROOT): AppConfigScan {
  const dir = join(root, "config", "apps");
  const scan: { loaded: AppConfig[]; notLoaded: NotLoadedApp[] } = { loaded: [], notLoaded: [] };
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".yaml") || f.startsWith("example")) continue;
      const app = f.replace(/\.yaml$/, "");
      try {
        scan.loaded.push(loadAppConfig(app, root));
      } catch (err) {
        scan.notLoaded.push({ app, file: `config/apps/${f}`, reason: err instanceof AppConfigInvalidError ? err.reason : err instanceof Error ? err.message : String(err) });
      }
    }
  }
  reportSkips(root, scan.notLoaded);
  return scan;
}

export function listAppConfigs(root = ROOT): AppConfig[] {
  return scanAppConfigs(root).loaded;
}
