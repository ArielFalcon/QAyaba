/* The mirror's history, as far as the served-version fact needs it: how the commit DEV serves relates to the run's sha. */

import type { Sha } from "../sha.ts";

/*
 * `same`: both name one commit. `served-is-ancestor`: the served commit is in the run's sha's history. `head-is-ancestor`: the run's
 * sha is in the served commit's history. `diverged`: neither is in the other's. `unknown-commit`: the mirror holds no such commit.
 */
export type CommitRelation = "same" | "served-is-ancestor" | "head-is-ancestor" | "diverged" | "unknown-commit";

export interface CommitAncestryPort {
  /** The mirror is brought up to date with its origin first, so a commit that landed after the last run is found. Throws when git cannot answer. */
  relation(served: string, head: Sha): Promise<CommitRelation>;
}
