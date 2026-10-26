import type { ChangePagesJoin } from "@kernel/change-pages.ts";
import type { ChangePagesRequest } from "../../domain/change-pages-model.ts";

/**
 * The pages of the map the run's call graph proves the change reaches (S10-S12). Advisory: it only adds pages, ranked after
 * the map's links, and never throws; undefined when no index could answer.
 */
export interface ChangePagesPort {
  resolve(request: ChangePagesRequest): Promise<ChangePagesJoin | undefined>;
}
