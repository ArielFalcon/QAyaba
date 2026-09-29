/*
 * The identity of a tool call for exact-duplicate detection: the tool plus its input, order-insensitive
 * over object keys, reduced to a fixed-size digest. A write's input carries the whole file body, and the
 * tracker keeps one identity per call for the life of a session, so the identity must not keep the input.
 */
import { createHash } from "node:crypto";

/** Rebuilds every object with its keys sorted, so equal inputs serialize equally whatever their key order. */
function withSortedKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
}

export function callFingerprint(tool: string, input: unknown): string {
  return createHash("sha256")
    .update(tool)
    .update("\u0000")
    .update(JSON.stringify(input ?? null, withSortedKeys))
    .digest("hex");
}
