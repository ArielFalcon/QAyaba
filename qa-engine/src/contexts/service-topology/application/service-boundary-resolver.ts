import type { BoundaryProfile } from "../domain/index.ts";
import type { ProfileScore } from "./profile-scorer.ts";

export interface ProposerFeedback {
  readonly priorCandidates: ReadonlyArray<{ profile: BoundaryProfile; score: ProfileScore }>;
}
