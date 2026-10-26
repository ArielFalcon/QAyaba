/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export { ResolveCrossRepoImpactUseCase } from "./resolve-cross-repo-impact.use-case.ts";
export type { CrossRepoVcsRead, MirrorRegistryLike } from "./resolve-cross-repo-impact.use-case.ts";
export type { BoundaryProfile, RepoRef } from "../domain/index.ts";
export type { ServiceLinksPort } from "./ports/service-links.port.ts";
export type { CrossRepoImpactPort } from "./ports/cross-repo-impact.port.ts";
export type { BoundaryProfileProviderPort } from "./ports/boundary-profile-provider.port.ts";
export type { ProfileProposerPort } from "./ports/profile-proposer.port.ts";
export type { ProposerFeedback } from "../domain/profile-score.ts";
export type { ResolveLinksResult } from "../domain/service-boundary-resolver.ts";
export { OnboardingService } from "./onboarding-service.ts";
export type { OnboardingResult, OnboardingRoundProgress } from "./onboarding-service.ts";
export type { EventBoundaryProfile, HttpBackendBoundaryProfile, HttpBoundaryProfile } from "../domain/index.ts";
