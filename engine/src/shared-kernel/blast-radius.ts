/* Files a commit changed, keyed by Sha, and, when the diff was read, the new-side lines it touched in each. Immutable; identity is deduped and sorted. A file absent from `touchedLines` has no line information (a consumer then takes the whole file), never "untouched". */

import { Sha } from "./sha.ts";

export type TouchedLines = ReadonlyMap<string, ReadonlySet<number>>;

export class BlastRadius {
  private constructor(readonly sha: Sha, readonly changedFiles: readonly string[], readonly touchedLines?: TouchedLines) {}

  static of(sha: Sha, changedFiles: readonly string[], touchedLines?: TouchedLines): BlastRadius {
    const normalized = Object.freeze([...new Set(changedFiles)].sort());
    return new BlastRadius(sha, normalized, touchedLines);
  }

  get isEmpty(): boolean {
    return this.changedFiles.length === 0;
  }
}
