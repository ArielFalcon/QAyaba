import type { BoundaryProfile } from "./index.ts";

/** How much of a candidate BoundaryProfile's extracted call-site pattern actually resolves. */
export interface ProfileScore {
  links: number;
  drift: number;
  external: number;
  unresolved: number;
  /** Total call-sites the pattern extracted, across all four result buckets. */
  coverage: number;
  /** links / coverage, or 0 when coverage === 0 (never NaN). */
  resolutionRatio: number;
  /** links resolutionRatio — resolved-volume weighted by precision. The primary ranking key: raw links reward over-extraction. */
  resolvedScore: number;
}

export interface ProposerFeedback {
  readonly priorCandidates: ReadonlyArray<{ profile: BoundaryProfile; score: ProfileScore }>;
}
