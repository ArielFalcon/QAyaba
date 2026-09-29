/*
 * The identity of a tool call for exact-duplicate detection: the tool plus its input, order-insensitive
 * over object keys, reduced to a fixed-size digest. A write's input carries the whole file body, and the
 * tracker keeps one identity per call for the life of a session, so the identity must not keep the input.
 */
import { createHash } from "node:crypto";

/** JSON with object keys sorted, so equal inputs stringify equally whatever their key order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function callFingerprint(tool: string, input: unknown): string {
  return createHash("sha256")
    .update(tool)
    .update("\u0000")
    .update(stableStringify(input ?? null))
    .digest("hex");
}
