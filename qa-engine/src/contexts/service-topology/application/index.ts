/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export { ResolveCrossRepoImpactUseCase } from "./resolve-cross-repo-impact.use-case.ts";
export type { CrossRepoVcsRead, MirrorRegistryLike } from "./resolve-cross-repo-impact.use-case.ts";
export type { BoundaryProfile, ContractDrift, RepoRef, ServiceLink } from "../domain/index.ts";
export type { ServiceLinksPort } from "./ports/service-links.port.ts";
export type { CrossRepoImpactPort } from "./ports/cross-repo-impact.port.ts";
export type { ServiceSymbolRef } from "../domain/index.ts";
export type { CrossRepoImpact, ImpactedLink, MatchTier } from "../domain/cross-repo-impact.ts";
export type { BoundaryProfileProviderPort } from "./ports/boundary-profile-provider.port.ts";
export type { ChangePagesPort } from "./ports/change-pages.port.ts";
export type { ProfileProposerPort } from "./ports/profile-proposer.port.ts";
export type { ProposerFeedback } from "./service-boundary-resolver.ts";
export type { ChangePagesRequest } from "../domain/change-pages-model.ts";
export type { ResolveLinksResult } from "../domain/service-boundary-resolver.ts";
