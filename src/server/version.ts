/*
 * Version/capability handshake. Unauthenticated so a stale client can be told to update
 * even with a wrong token. The server owns compatibility policy.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { VersionInfo } from "../contract/commands";

export const WIRE_API_VERSION = "v1";

export const MIN_CLIENT_VERSION = "0.1.0";

export const CAPABILITIES = [
  "runs", "run-events-sse", "ask", "continue", "cancel",
  "queue", "apps", "repos", "agent-runtime", "history",
] as const;

export const SERVER_VERSION = readServerVersion();

function readServerVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function handshake(clientVersion?: string, githubClientId?: string): VersionInfo {
  const compatible = clientVersion ? versionGte(clientVersion, MIN_CLIENT_VERSION) : true;
  return {
    serverVersion: SERVER_VERSION,
    apiVersion: WIRE_API_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    compatible,
    capabilities: [...CAPABILITIES],
    ...(githubClientId ? { githubClientId } : {}),
    ...(compatible ? {} : { message: `Update qayaba: this server requires client >= ${MIN_CLIENT_VERSION} (you have ${clientVersion}).` }),
  };
}

export function versionGte(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

function parseVersion(v: string): number[] {
  const core = v.replace(/^v/, "").split("-")[0] ?? "";
  return core.split(".").map((n) => Number.parseInt(n, 10) || 0);
}
