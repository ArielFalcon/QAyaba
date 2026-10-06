/* Scrubbed environment for an untrusted spawn. Drops orchestrator secrets; keeps OS + language vars. Callers widen the base only for their own spawns (`extraExact` / `extraAllowed`); CBM_CACHE_DIR is not in the base allowlist. */

/* Secret FAMILIES that must never reach untrusted code (prefix match). Defense-in-depth: the allowlist is the real gate, but blocking secrets explicitly guards against an allowlist entry widening to one. */
const BLOCKED_ENV_PREFIX = /^(?:GITHUB_TOKEN|GH_TOKEN|GIT_TOKEN|GITLAB_TOKEN|OPENCODE_API_KEY|WEBHOOK_SECRET|QA_API_TOKEN|DOPPLER_|AWS_|AZURE_|GCP_|GOOGLE_APPLICATION_CREDENTIALS|NPM_TOKEN|NODE_AUTH_TOKEN)/;

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

/* Network plumbing an install needs behind a corporate proxy that re-terminates TLS. Not secrets — except a proxy URL that embeds credentials (scheme://user:pass@host), which is dropped. */
const NETWORK_ENV_EXACT = new Set([
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
]);
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i;

export interface ScrubEnvOptions {
  extraExact?: Set<string>;
  extraAllowed?: RegExp;
}

export function scrubEnv(opts?: ScrubEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (BLOCKED_ENV_PREFIX.test(key)) continue;
    if (NETWORK_ENV_EXACT.has(key)) {
      if (URL_WITH_CREDENTIALS.test(value)) dropped.push(key);
      else env[key] = value;
      continue;
    }
    if (
      ALLOWED_ENV_EXACT.has(key) ||
      ALLOWED_ENV_PREFIX.test(key) ||
      (opts?.extraExact?.has(key) ?? false) ||
      (opts?.extraAllowed?.test(key) ?? false)
    ) {
      env[key] = value;
    } else {
      dropped.push(key);
    }
  }
  if (dropped.length > 0) {
    console.warn(`[qa] scrubEnv dropped ${dropped.length} env var(s) not in allowlist: ${dropped.join(", ")}`);
  }
  return env;
}
