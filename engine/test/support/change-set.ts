/* A one-entry change set for run inputs that need one: the app's primary repo at `sha`. */
import type { Sha } from "@kernel/sha.ts";
import { ChangeSet } from "@contexts/change-analysis/application/index.ts";

export function primaryChangeSet(app: string, sha: Sha): ChangeSet {
  return ChangeSet.of(app, [{ repo: `org/${app}`, role: "primary", headSha: sha }]);
}
