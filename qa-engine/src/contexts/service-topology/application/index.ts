/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export type { BoundaryProfileProviderPort } from "./ports/index.ts";
export { ResolveCrossRepoImpactUseCase } from "./resolve-cross-repo-impact.use-case.ts";
export type { CrossRepoVcsRead, MirrorRegistryLike } from "./resolve-cross-repo-impact.use-case.ts";
export type { BoundaryProfile, ContractDrift, RepoRef, ServiceLink } from "./../domain/index.ts";
