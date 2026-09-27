/*
 * Child-env overlay for a prepared e2e auth session. Reads files AuthSessionAdapter.prepare() wrote
 * under `authDir` — an orchestrator-only directory OUTSIDE the watched-repo mirror (the agents
 * container mounts the mirrors volume but not qa-data, so this directory is never agent-visible).
 * Does not read secrets from process.env, and never falls back to a mirror-relative path.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function authSessionEnv(authDir: string, baseEnv: Record<string, string>): Record<string, string> {
  const storage = join(authDir, "user.json");
  const cert = join(authDir, "client.p12");
  const passFile = join(authDir, "cert.pass");
  const env: Record<string, string> = { ...baseEnv };
  if (existsSync(storage)) env.PW_STORAGE_STATE = storage;
  if (existsSync(cert)) {
    env.PW_CLIENT_CERT_PATH = cert;
    if (existsSync(passFile)) env.DEV_CLIENT_CERT_PASS = readFileSync(passFile, "utf8");
  }
  return env;
}
