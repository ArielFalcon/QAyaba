/* One digest for a whole spec set, so a step can say whether the files changed: the fix loop's before and after, and a checkpoint's workspace. The reader is the caller's (the confined one), so this module touches no file. */

import { createHash } from "node:crypto";

/** The digest of a set with no file in it. */
export const EMPTY_SPEC_SET_DIGEST = createHash("sha256").digest("hex");

/* Sorted, sha256 over `file + "\0" + bytes`; undefined when the set is empty or any file cannot be read. */
export function specSetDigest(read: (file: string) => string, files: readonly string[]): string | undefined {
  const unique = [...new Set(files)].sort();
  if (unique.length === 0) return undefined;
  const hash = createHash("sha256");
  for (const file of unique) {
    try {
      hash.update(file).update("\0").update(read(file));
    } catch {
      return undefined;
    }
  }
  return hash.digest("hex");
}
