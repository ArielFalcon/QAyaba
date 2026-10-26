import type { ChangePagesJoin } from "@kernel/change-pages.ts";
import type { ArchitectureContext } from "@kernel/grounding.ts";
import type { CrossRepoImpact } from "../../domain/cross-repo-impact.ts";

export interface ChangePagesRequest {
  map: ArchitectureContext;
  sha: string;
  changedFiles: readonly string[];
  touchedLines?: ReadonlyMap<string, ReadonlySet<number>>;
  /** The pages the map already links to the change: they keep the map's basis. */
  linked: ReadonlySet<string>;
  crossRepoImpact?: CrossRepoImpact | null;
}

/**
 * The pages of the map the run's call graph proves the change reaches (S10-S12). Advisory: it only adds pages, ranked after
 * the map's links, and never throws; undefined when no index could answer.
 */
export interface ChangePagesPort {
  resolve(request: ChangePagesRequest): Promise<ChangePagesJoin | undefined>;
}
