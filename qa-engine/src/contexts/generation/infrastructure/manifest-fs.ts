/* Manifest file IO. `targets`/`changeRef` are required; `file` stays optional so a hand-edited entry lacking it is not rejected. The manifest sits in a directory the agent writes into, so it is read and written strictly (readOwnedSpecFile, writeOwnedSpecFile): a link or a pipe at the file or at `.qa` is refused, never followed, and a write goes through a temporary file renamed over the target. */
import { createHash } from "node:crypto";
import type { ManifestEntry } from "../application/ports/index.ts";
import { MANIFEST_FILE, MAX_MANIFEST_BYTES, manifestEntryViolation } from "@kernel/manifest/manifest-entry.ts";
import { ConfinedPathError, readConfinedSpecBytes, readOwnedSpecFile, writeOwnedSpecFile, type SpecRoot } from "../../../shared-infrastructure/spec-path-confinement.ts";

/* The hash of a file the agent named, read through the confined reader: a name that leaves the spec directory, or is not a file in it, has none, exactly like a name that is not on disk. */
function sha256File(root: SpecRoot, file: string): string | undefined {
  let bytes: Buffer;
  try {
    bytes = readConfinedSpecBytes(root, file);
  } catch {
    return undefined;
  }
  return createHash("sha256").update(bytes).digest("hex");
}

type Loaded = { entries: ManifestEntry[] } | { refused: string };

/* The entries on disk. A manifest that is missing, unreadable, corrupt or not an array has none: fail-open. A manifest the strict read refuses (a link, a pipe, a directory, a file over the cap) is not "none": it is refused, and the caller says what that means. */
function loadManifest(root: SpecRoot): Loaded {
  let read;
  try {
    read = readOwnedSpecFile(root, MANIFEST_FILE, MAX_MANIFEST_BYTES);
  } catch {
    return { entries: [] };
  }
  if ("reason" in read) return { refused: read.reason };
  if ("absent" in read) return { entries: [] };
  try {
    const parsed: unknown = JSON.parse(read.bytes.toString("utf8"));
    return { entries: Array.isArray(parsed) ? (parsed as ManifestEntry[]) : [] };
  } catch {
    return { entries: [] };
  }
}

/** Fail-open: a missing, unreadable, corrupt, or non-array manifest degrades to [] — never throw. A manifest the agent planted a link or a pipe at is taken for no manifest too, and said so. With no mirror known here, the spec directory anchors itself: that still refuses a symlinked spec directory and every link below it. */
export async function readManifest(specDir: string): Promise<ManifestEntry[]> {
  const loaded = loadManifest({ mirrorDir: specDir, specDir });
  if ("refused" in loaded) {
    console.warn(`[qa] WARNING: the manifest of ${specDir} is not read (${loaded.refused}); it is taken for no manifest.`);
    return [];
  }
  return loaded.entries;
}

/* The disk-existence check must distinguish "file declared but NOT on disk" (a real phantom — drop it) from "no file declared at all" (not a phantom — keep it, sha256 stays undefined, never fabricated). */
function safetyFilter(root: SpecRoot, entries: readonly ManifestEntry[]): ManifestEntry[] {
  const withSha = entries.map((e) => {
    if (!e.file) return { e, sha256: undefined, phantom: false };
    const sha256 = sha256File(root, e.file);
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

/* Merges the entries into the manifest and writes it. A manifest that cannot be read or written strictly is not merged into or replaced: that is thrown, as ConfinedPathError, and reaches the run, since a manifest that was not written is not a manifest. */
export async function reconcileManifest(root: SpecRoot, entries: readonly ManifestEntry[]): Promise<ManifestEntry[]> {
  if (entries.length === 0) return [];

  const safeEntries = safetyFilter(root, entries);
  if (safeEntries.length === 0) return [];

  const loaded = loadManifest(root);
  if ("refused" in loaded) throw new ConfinedPathError(MANIFEST_FILE, loaded.refused);

  const byId = new Map<string, ManifestEntry>();
  for (const e of loaded.entries) if (e && typeof e.id === "string") byId.set(e.id, e);
  for (const e of safeEntries) byId.set(e.id, { ...byId.get(e.id), ...e });

  const merged = [...byId.values()];
  writeOwnedSpecFile(root, MANIFEST_FILE, JSON.stringify(merged, null, 2));
  return merged;
}
