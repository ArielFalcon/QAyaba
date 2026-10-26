import type { RepoRef, BoundaryProfile } from "../../domain/index.ts";
import type { ProposerFeedback } from "../../domain/profile-score.ts";

/** Proposes candidate BoundaryProfiles for an app during onboarding (profile-generator tool). NEVER throws: any error degrades to an empty array (fail-open) — a proposer failure must never crash the onboarding loop, only cost it a round (mirrors the resolver ports' fail-open discipline). */
export interface ProfileProposerPort {
  propose(system: RepoRef[], front: RepoRef, feedback?: ProposerFeedback): Promise<BoundaryProfile[]>;
}
