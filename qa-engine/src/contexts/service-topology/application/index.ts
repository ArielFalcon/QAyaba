/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export type { BoundaryProfileProviderPort } from "./ports/index.ts";
export { ResolveCrossRepoImpactUseCase } from "./resolve-cross-repo-impact.use-case.ts";
export type { CrossRepoVcsRead, MirrorRegistryLike } from "./resolve-cross-repo-impact.use-case.ts";
export type { BoundaryProfile, ContractDrift, RepoRef, ServiceLink } from "../domain/index.ts";
export type { ServiceLinksPort } from "./ports/service-links.port.ts";
export type { CrossRepoImpactPort } from "./ports/cross-repo-impact.port.ts";
export type { ChangePagesPort, ChangePagesRequest } from "./ports/change-pages.port.ts";
export type { ServiceSymbolRef } from "../domain/index.ts";
export type { CrossRepoImpact, ImpactedLink, MatchTier } from "../domain/cross-repo-impact.ts";
