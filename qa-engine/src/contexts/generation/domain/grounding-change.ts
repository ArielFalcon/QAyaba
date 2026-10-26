import type { ServiceLink, CrossRepoImpact } from "@kernel/service-links.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";

/** What grounding needs beyond the map: the change, the use cases it makes testable, and on a cross-repo run the stitcher's links as they are. */
export interface GroundingChange {
  sha: string;
  serviceLinks?: readonly ServiceLink[];
  crossRepoImpact?: CrossRepoImpact | null;
  /** The change's use-case candidates: their pages rank the pack's capture by tier. */
  candidates?: readonly UseCaseCandidate[];
  /** Pages a changed symbol reached too many of to name any as a candidate: they only order the capture, after every candidate and before the rest. */
  hubPages?: readonly string[];
}
