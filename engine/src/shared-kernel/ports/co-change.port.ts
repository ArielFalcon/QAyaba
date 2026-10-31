/* Advisory only: which files version control recorded changing in the same commits as the changed ones. A history question, not a structural one: it says nothing about what depends on what. `repoDir` names a repo by its mirror; the history read is the run's commit and its ancestors, never the mirror's checkout. */

import type { Result } from "@kernel/result.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { CodeGraphUnavailable, CoupledFile } from "@kernel/code/index.ts";

export interface CoChangePort {
  /** Files that co-changed with the changed files before the run's commit, strongest first, the changed files themselves excluded. */
  coChangeCoupling(repoDir: string, changed: BlastRadius): Promise<Result<CoupledFile[], CodeGraphUnavailable>>;
}
