/*
 * Child-env overlay for a prepared e2e auth session. Reads files AuthSessionAdapter.prepare() wrote
 * under `authDir` — an orchestrator-only directory OUTSIDE the watched-repo mirror (the agents
 * container mounts the mirrors volume but not qa-data, so this directory is never agent-visible).
 * Does not read secrets from process.env, and never falls back to a mirror-relative path.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* The auth material files under authDir: written by AuthSessionAdapter.prepare(), read here. */
export const AUTH_MATERIAL_FILES = {
  storageState: "user.json",
  clientCert: "client.p12",
  certPass: "cert.pass",
} as const;

export function authSessionEnv(authDir: string, baseEnv: Record<string, string>): Record<string, string> {
  const storage = join(authDir, AUTH_MATERIAL_FILES.storageState);
  const cert = join(authDir, AUTH_MATERIAL_FILES.clientCert);
  const passFile = join(authDir, AUTH_MATERIAL_FILES.certPass);
  const env: Record<string, string> = { ...baseEnv };
  if (existsSync(storage)) env.PW_STORAGE_STATE = storage;
  if (existsSync(cert)) {
    env.PW_CLIENT_CERT_PATH = cert;
    if (existsSync(passFile)) env.DEV_CLIENT_CERT_PASS = readFileSync(passFile, "utf8");
  }
  return env;
}
