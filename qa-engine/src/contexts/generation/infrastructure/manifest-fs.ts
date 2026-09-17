/* Manifest file IO. `targets`/`changeRef` are required; `file` stays optional so a hand-edited entry lacking it is not rejected. */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { ManifestEntry } from "../application/ports/index.ts";
import { manifestEntryViolation } from "@kernel/manifest/manifest-entry.ts";

function manifestPath(specDir: string): string {
  return join(specDir, ".qa", "manifest.json");
}


function sha256File(path: string): string | undefined {
  try {
    const data = readFileSync(path);
    return createHash("sha256").update(data).digest("hex");
  } catch {
    return undefined;
  }
}

/** Fail-open: a missing, unreadable, corrupt, or non-array manifest degrades to [] — never throw. */
export async function readManifest(specDir: string): Promise<ManifestEntry[]> {
  const path = manifestPath(specDir);
  let raw: string | null;
  try {
    raw = existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    raw = null;
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ManifestEntry[]) : [];
  } catch {
    return [];
  }
}

/* The disk-existence check must distinguish "file declared but NOT on disk" (a real phantom — drop it) from "no file declared at all" (not a phantom — keep it, sha256 stays undefined, never fabricated). */
function safetyFilter(specDir: string, entries: readonly ManifestEntry[]): ManifestEntry[] {
  const withSha = entries.map((e) => {
    if (!e.file) return { e, sha256: undefined, phantom: false };
    const sha256 = sha256File(join(specDir, e.file));
    return { e, sha256, phantom: sha256 === undefined };
  });
  const onDisk = withSha
    .filter(({ e, phantom }) => {
      if (phantom) {
        console.warn(`[qa] WARNING: agent reported spec '${e.file}' in its manifest metadata but it is not on disk — dropping the phantom manifest entry.`);
        return false;
      }
      return true;
    })
    .map(({ e, sha256 }) => (sha256 !== undefined ? { ...e, sha256 } : e));

  return onDisk.filter((e) => {
    const violation = manifestEntryViolation(e);
    if (violation) {
      console.warn(`[qa] WARNING: dropping manifest entry '${e.id}' — it fails the manifest schema: ${violation}.`);
      return false;
    }
    return true;
  });
}

export async function reconcileManifest(specDir: string, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]> {
  const path = manifestPath(specDir);
  if (entries.length === 0) return [];

  const safeEntries = safetyFilter(specDir, entries);
  if (safeEntries.length === 0) return [];

  let existing: ManifestEntry[] = [];
  try {
    const raw = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) existing = parsed as ManifestEntry[];
    }
  } catch {
  }

  const byId = new Map<string, ManifestEntry>();
  for (const e of existing) if (e && typeof e.id === "string") byId.set(e.id, e);
  for (const e of safeEntries) byId.set(e.id, { ...byId.get(e.id), ...e });

  const merged = [...byId.values()];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2));
  return merged;
}
