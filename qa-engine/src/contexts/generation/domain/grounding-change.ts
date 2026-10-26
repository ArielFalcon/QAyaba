import type { ServiceLink, CrossRepoImpact } from "@kernel/service-links.ts";

/** What the change-page join needs beyond the map: the change, and on a cross-repo run the stitcher's links as they are. */
export interface GroundingChange {
  sha: string;
  serviceLinks?: readonly ServiceLink[];
  crossRepoImpact?: CrossRepoImpact | null;
}
