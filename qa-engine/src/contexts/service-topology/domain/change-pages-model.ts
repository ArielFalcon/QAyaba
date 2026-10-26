import type { CrossRepoImpact } from "@kernel/service-links.ts";
import type { ArchitectureContext } from "@kernel/grounding.ts";

export interface ChangePagesRequest {
  map: ArchitectureContext;
  sha: string;
  changedFiles: readonly string[];
  touchedLines?: ReadonlyMap<string, ReadonlySet<number>>;
  /** The pages the map already links to the change: they keep the map's basis. */
  linked: ReadonlySet<string>;
  crossRepoImpact?: CrossRepoImpact | null;
}
