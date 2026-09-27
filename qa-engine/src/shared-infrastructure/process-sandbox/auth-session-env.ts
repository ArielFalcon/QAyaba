/* Child-env overlay for a prepared e2e auth session. Reads files prepare() wrote under specDir/.auth/. Does not read secrets from process.env. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function authSessionEnv(specDir: string, baseEnv: Record<string, string>): Record<string, string> {
  const storage = join(specDir, ".auth", "user.json");
  const cert = join(specDir, ".auth", "client.p12");
  const passFile = join(specDir, ".auth", "cert.pass");
  const env: Record<string, string> = { ...baseEnv };
  if (existsSync(storage)) env.PW_STORAGE_STATE = storage;
  if (existsSync(cert)) {
    env.PW_CLIENT_CERT_PATH = cert;
    if (existsSync(passFile)) env.DEV_CLIENT_CERT_PASS = readFileSync(passFile, "utf8");
  }
  return env;
}
