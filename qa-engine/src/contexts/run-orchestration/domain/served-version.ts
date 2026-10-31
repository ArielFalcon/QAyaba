/* The served-version decision, pure: which state a served commit has against the run's sha, and when the gate waits for it. */

import type { CommitRelation } from "@kernel/ports/commit-ancestry.port.ts";
import type { TriggerSource } from "@kernel/run-mode.ts";
import type { ServedVersionState } from "@kernel/served-version.ts";
import { shaMatches, type Sha } from "@kernel/sha.ts";

/* Whether the served commit is not obviously the run's own, so the mirror's history is needed to say how they relate. */
export function needsHistory(served: string, head: Sha): boolean {
  return !shaMatches(served, head.value);
}

/*
 * The state of a commit that was read. `relation` is what the history said and is required exactly when `needsHistory` is true.
 * A served commit the mirror does not hold has no state here: ancestry was not established, and the gate records it unreadable.
 */
export function servedState(served: string, head: Sha, relation: Exclude<CommitRelation, "unknown-commit"> | undefined): Extract<ServedVersionState, "equal" | "behind" | "ahead" | "unrelated"> {
  if (!needsHistory(served, head)) return "equal";
  if (relation === undefined) throw new Error(`the served commit ${served} differs from ${head.short}: its state needs the history's relation`);
  switch (relation) {
    case "same": return "equal";
    case "served-is-ancestor": return "behind";
    case "head-is-ancestor": return "ahead";
    case "diverged": return "unrelated";
    default: throw new Error(`the relation ${String(relation)} establishes no state for the served commit ${served}`);
  }
}

/* A replay cannot become equal by waiting: only a run started by a deploy waits, and only while the deploy has not landed. */
export function waitsForDeploy(state: ServedVersionState, source: TriggerSource): boolean {
  return source === "webhook" && state === "behind";
}
