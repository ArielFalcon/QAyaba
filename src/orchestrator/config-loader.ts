/*
 * Loads and validates watched-app config. App-specific detail lives in config/, never in code.
 * ${VARS} expand from the environment so credentials never live in the repo.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { AppConfigSchema, type ValidatedAppConfig } from "./schemas";

const ROOT = process.env.QAYABA_ROOT ?? process.cwd();

export interface AppConfig extends ValidatedAppConfig {}

export function loadAppConfig(name: string, root = ROOT): ValidatedAppConfig {
  const path = join(root, "config", "apps", `${name}.yaml`);
  if (!existsSync(path)) {
    throw new Error(`config/apps/${name}.yaml not found — is the app onboarded?`);
  }
  const raw = expandEnv(readFileSync(path, "utf8"));
  return AppConfigSchema.parse(parse(raw));
}

/* An unset ${VAR} silently un-watches an app — surface it as an error, not a malformed-YAML skip. */
function logConfigSkip(file: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (/unset env var/.test(msg)) {
    console.error(
      `[qa] CONFIG ERROR: ${file} references an unset env var — this app will NOT be watched ` +
        `(no webhooks processed for it) until the variable is set in the environment: ${msg}`,
    );
  } else {
    console.warn(`[qa] skipping malformed config ${file}: ${msg}`);
  }
}

export type RepoRole = "primary" | "service";

export interface RepoMatch {
  app: AppConfig;
  role: RepoRole;
}

/* One repo can be primary of one app and a service of another; enqueue one run per match. */
export function loadAppConfigsByRepo(repo: string, root = ROOT): RepoMatch[] {
  const dir = join(root, "config", "apps");
  if (!existsSync(dir)) return [];
  const out: RepoMatch[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml") || file.startsWith("example")) continue;
    let cfg: AppConfig;
    try {
      cfg = loadAppConfig(file.replace(/\.yaml$/, ""), root);
    } catch (err) {
      logConfigSkip(file, err);
      continue;
    }
    if (cfg.repo === repo) out.push({ app: cfg, role: "primary" });
    else if (cfg.services?.some((s) => s.repo === repo)) out.push({ app: cfg, role: "service" });
  }
  return out;
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

export function expandEnv(s: string, env: Record<string, string | undefined> = process.env): string {
  /* Match any shell-style identifier (not uppercase-only) so a mis-cased ${myToken} fails as unset. */
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
    const val = env[key];
    if (val === undefined) throw new Error(`config references unset env var \${${key}}`);
    return val;
  });
}
