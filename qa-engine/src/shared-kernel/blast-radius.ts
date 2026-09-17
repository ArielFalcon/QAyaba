/* Files a commit changed, keyed by Sha. Immutable; identity is deduped and sorted. */

import { Sha } from "./sha.ts";

export class BlastRadius {
  private constructor(readonly sha: Sha, readonly changedFiles: readonly string[]) {}

  static of(sha: Sha, changedFiles: readonly string[]): BlastRadius {
    const normalized = Object.freeze([...new Set(changedFiles)].sort());
    return new BlastRadius(sha, normalized);
  }

  get isEmpty(): boolean {
    return this.changedFiles.length === 0;
  }
}
