/* The engine's read-equivalent answer for a bag of names (symbols, files, short code terms): the verbatim source of the matching symbols grouped by file, with the calls among them. Text for a model to read, never parsed. `repoDir` names a repo by its mirror; the answer comes from the index the run built of that repo, and carries its commit. */

import type { Result } from "@kernel/result.ts";
import type { CodeGraphUnavailable } from "@kernel/code/index.ts";

export interface ExploreAnswer {
  text: string;
  /** The commit of the index the answer was read from. */
  indexedSha: string;
}

export interface CodeExplorePort {
  /** `terms` are passed to the engine as terms, never as options. A repo the run did not index answers unavailable. */
  explore(repoDir: string, terms: readonly string[], maxFiles: number): Promise<Result<ExploreAnswer, CodeGraphUnavailable>>;
}
