/*
 * The run's saved session as the agent browser's context needs it, read into memory from the orchestrator-only auth
 * directory of the run's scope. Nothing here is written anywhere, and nothing that is read is kept past the call that
 * asked: the host reads it again for each context it builds, so a session renewed in between is the one used. Read strictly
 * (no link, a regular file, under a cap), like every other read of that directory.
 */

import { activeExecScope } from "../../../../shared-infrastructure/process-sandbox/exec-scope.ts";
import { AUTH_MATERIAL_FILES } from "../../../../shared-infrastructure/process-sandbox/auth-session-env.ts";
import { readOwnedSpecFile } from "../../../../shared-infrastructure/spec-path-confinement.ts";
import { originOf } from "../../../../shared-infrastructure/egress/egress-policy.ts";
import type { SessionMaterial } from "@contexts/test-execution/infrastructure/agent-browser/playwright-types.ts";

const MAX_STORAGE_STATE_BYTES = 4 * 1024 * 1024;
const MAX_CLIENT_CERT_BYTES = 1024 * 1024;
const MAX_CERT_PASS_BYTES = 4096;

function readStrict(authDir: string, name: string, maxBytes: number): Buffer | undefined {
  try {
    const read = readOwnedSpecFile({ mirrorDir: authDir, specDir: authDir }, name, maxBytes);
    return "bytes" in read ? read.bytes : undefined;
  } catch {
    return undefined;
  }
}

function storageStateOf(bytes: Buffer): SessionMaterial["storageState"] {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as { cookies?: unknown; origins?: unknown };
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) return undefined;
    return { cookies: parsed.cookies, origins: parsed.origins };
  } catch {
    return undefined;
  }
}

/* Must be called inside the run's scope: the auth directory and the gate's credentials are the scope's. */
export function readAgentBrowserSession(baseUrl: string): SessionMaterial {
  const scope = activeExecScope();
  if (!scope) return {};
  const material: SessionMaterial = {};
  if (scope.authDir !== undefined) {
    const state = readStrict(scope.authDir, AUTH_MATERIAL_FILES.storageState, MAX_STORAGE_STATE_BYTES);
    const storage = state ? storageStateOf(state) : undefined;
    if (storage) material.storageState = storage;
    const cert = readStrict(scope.authDir, AUTH_MATERIAL_FILES.clientCert, MAX_CLIENT_CERT_BYTES);
    const origin = originOf(baseUrl);
    if (cert && origin) {
      const pass = readStrict(scope.authDir, AUTH_MATERIAL_FILES.certPass, MAX_CERT_PASS_BYTES);
      material.clientCertificate = { origin, pfx: cert, ...(pass ? { passphrase: pass.toString("utf8") } : {}) };
    }
  }
  if (scope.gateCreds) material.httpCredentials = { username: scope.gateCreds.user, password: scope.gateCreds.pass };
  return material;
}
