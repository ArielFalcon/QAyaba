import type { ServiceLink, CrossRepoImpact } from "@kernel/service-links.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { ChangeClosure } from "@kernel/route-availability.ts";

/** What grounding needs beyond the map: the change, the use cases it makes testable, and on a cross-repo run the stitcher's links as they are. */
export interface GroundingChange {
  sha: string;
  serviceLinks?: readonly ServiceLink[];
  crossRepoImpact?: CrossRepoImpact | null;
  /** The change's use-case candidates: their pages rank the pack's capture by tier. */
  candidates?: readonly UseCaseCandidate[];
  /** Pages a changed symbol reached too many of to name any as a candidate: they only order the capture, after every candidate and before the rest. */
  hubPages?: readonly string[];
  /** The run's base: the start of its range (`<sha>~n`, the base sha, or the parent). Absent: no route table is read at the base, so no route is proven unchanged. */
  baseRef?: string;
  /** The app's declared login page (auth.loginPath). */
  loginPath?: string;
  /** The symbols the code graph's walk from the change reached and whether that walk was complete (E2 of the availability classification), asked for only when a captured route was unavailable. Absent, or answering undefined: no guard is proven unreached. */
  changeClosure?: () => Promise<ChangeClosure | undefined>;
}
