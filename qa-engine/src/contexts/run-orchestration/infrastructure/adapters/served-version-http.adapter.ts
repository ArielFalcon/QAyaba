/*
 * The one reader of a declared version source: a bare GET (no headers) of the address an app declares, answered as
 * `{ sha, healthy }`. It reports only what the product serves; whether that is the run's commit is the engine's decision.
 */

import { Sha } from "@kernel/sha.ts";
import type { ServedVersionReaderPort } from "@kernel/ports/served-version-reader.port.ts";
import type { ServedVersionRead } from "@kernel/served-version.ts";

export const SERVED_VERSION_READ_TIMEOUT_MS = 10_000;

export function httpServedVersionReader(fetchImpl: typeof fetch = fetch): ServedVersionReaderPort {
  return {
    async read(url: string): Promise<ServedVersionRead> {
      let res: Response;
      try {
        res = await fetchImpl(url, { signal: AbortSignal.timeout(SERVED_VERSION_READ_TIMEOUT_MS) });
      } catch {
        return { kind: "unreadable", reason: "unreachable" };
      }
      if (!res.ok) return { kind: "unreadable", reason: "http-status" };
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { kind: "unreadable", reason: "malformed-body" };
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return { kind: "unreadable", reason: "malformed-body" };
      const { sha, healthy } = body as { sha?: unknown; healthy?: unknown };
      const commit = typeof sha === "string" ? Sha.tryOf(sha) : null;
      if (commit === null) return { kind: "unreadable", reason: "no-commit" };
      return { kind: "read", commit: commit.value, healthy: typeof healthy === "boolean" ? healthy : undefined };
    },
  };
}
