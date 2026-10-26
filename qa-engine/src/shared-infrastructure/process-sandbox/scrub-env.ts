import { engineLog } from "@kernel/ports/process-logger.ts";

/* Scrubbed environment for an untrusted spawn. Drops orchestrator secrets; keeps OS + language vars. Callers widen the base only for their own spawns (`extraAllowed`). */

/* Secret FAMILIES that must never reach untrusted code (prefix match). Defense-in-depth: the allowlist is the real gate, but blocking secrets explicitly guards against an allowlist entry widening to one. */
const BLOCKED_ENV_PREFIX = /^(?:GITHUB_TOKEN|GH_TOKEN|OPENCODE_API_KEY|OPENCODE_SERVER_PASSWORD|WEBHOOK_SECRET|QA_API_TOKEN|DOPPLER_|LANGFUSE_|AWS_|AZURE_|GCP_|GOOGLE_APPLICATION_CREDENTIALS|NPM_TOKEN|NODE_AUTH_TOKEN)/;
/* Any provider's API key, whatever the provider is named: a model provider added in config brings its key with it. */
const BLOCKED_ENV_SUFFIX = /_API_KEY$/;

/* Allowed exact var names (OS + language essentials that are single vars, not families). */
const ALLOWED_ENV_EXACT = new Set([
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "TMPDIR", "TEMPDIR", "TMP", "TEMP",
  "NODE_ENV", "CI", "PYTHON", "VIRTUAL_ENV", "GOPATH", "GOROOT", "GOPRIVATE", "GOPROXY",
  "GONOSUMCHECK", "GOFLAGS", "GOCACHE", "JAVA_HOME", "M2_HOME", "M2_REPO", "M2", "NVM_DIR", "NODE_PATH", "NODE_OPTIONS",
  "DISPLAY", "SSH_AUTH_SOCK", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "DEBUG",
  "PKG_CONFIG_PATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
]);

/* Exported so sandbox.ts can scope its own home-rebase rule to exactly this family of
   package-manager/locale vars (never to PATH or other executable-search vars) — single source of
   truth for "which prefixes are package-manager config", kept in lockstep with the allowlist. */
export const ALLOWED_ENV_PREFIX = /^(?:LC_|npm_config_|PIP_|CGO_|CARGO_|RUSTUP_|RUST_|GRADLE_|MAVEN_|PNPM_|YARN_|COREPACK_)/;

export interface ScrubEnvOptions {
  extraAllowed?: RegExp;
  /* Skip the warning that names the variables left out; for a caller that scrubs on every spawn. */
  quiet?: boolean;
}

/* The sets of variables already named: a spawn site scrubs the same environment on every spawn, and one line per set is enough. */
const named = new Set<string>();

export function scrubEnv(opts?: ScrubEnvOptions): Record<string, string> {
  return scrubEnvFrom(process.env, opts);
}

/* The same filter over an env the caller hands in, so that a module that must not read process.env (the execution launcher) can reuse the one allowlist. */
export function scrubEnvFrom(source: NodeJS.ProcessEnv, opts?: ScrubEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (BLOCKED_ENV_PREFIX.test(key) || BLOCKED_ENV_SUFFIX.test(key)) continue;
    if (
      ALLOWED_ENV_EXACT.has(key) ||
      ALLOWED_ENV_PREFIX.test(key) ||
      (opts?.extraAllowed?.test(key) ?? false)
    ) {
      env[key] = value;
    } else {
      dropped.push(key);
    }
  }
  const set = dropped.join(",");
  if (dropped.length > 0 && opts?.quiet !== true && !named.has(set)) {
    named.add(set);
    engineLog.warn(`[qa] scrubEnv dropped ${dropped.length} env var(s) not in allowlist: ${dropped.join(", ")}`);
  }
  return env;
}
