/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export { classifyRange, ACTION_SEVERITY } from "../domain/commit-classification.ts";
export { ChangeSet, anchorProjection } from "@kernel/change-set.ts";
export type { ChangeEntry, ChangeRole } from "@kernel/change-set.ts";
export type { ChangeAnalysisPort } from "./ports/change-analysis.port.ts";
export type { VcsReadPort } from "./ports/vcs-read.port.ts";
export type { ChangeScopePort, ChangeScopeRepo, ChangeScopeRequest } from "./ports/change-scope.port.ts";
export { buildChangeScope, changedSymbolOf, tierOf, walkChains, CHANGE_SCOPE_LIMITS } from "../domain/reach-proof.ts";
export type { ProofInput, ProofWalk, ReachHit, ReachLink, ReachProof, ScopeInput, WalkChain } from "../domain/reach-proof.ts";
export { entryKey, MAX_KNOWN_ENTRY_POINTS } from "../domain/change-scope.ts";
export type { ChangedSymbol, ChangeScope, EntryPoint, ReachBasis, ReachEntry, ReachTier, RepoScope, ScopeDisagreement, ScopeHub } from "../domain/change-scope.ts";
export { candidateId, deriveCandidates } from "../domain/use-case-candidate.ts";
export type { CandidateEnrichment, MapLink, Reachability, UseCaseCandidate } from "../domain/use-case-candidate.ts";
export type { PageMap } from "../domain/page-files.ts";
export { fileImplementsPage } from "../domain/reach-proofs/file-implements-page.ts";
export { crossRepoCallSite } from "../domain/reach-proofs/cross-repo-call-site.ts";
export { openapiOperationDiff } from "../domain/reach-proofs/openapi-operation-diff.ts";
export { handlerServesOperation } from "../domain/reach-proofs/handler-serves-operation.ts";
export type { ServesOperation } from "../domain/reach-proofs/handler-serves-operation.ts";
