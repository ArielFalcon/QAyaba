export {
  COORDINATION_ACTIONS,
  isCoordinationAction,
  type CoordinationAction,
  type CoordinationDecision,
} from "./coordination-decision.ts";
export type { CoordinationBudget } from "./coordination-budget.ts";
export type { AcceptanceCriterion, CoordinationContext } from "./coordination-context.ts";
export type { EvidenceConfidence, EvidenceKind, EvidenceRef } from "./evidence-ref.ts";
export {
  evidenceFromBudget,
  evidenceFromChangeAnalysis,
  evidenceFromCoverage,
  evidenceFromEmptyRead,
  evidenceFromExecution,
  evidenceFromFailureClass,
  evidenceFromFixLoop,
  evidenceFromGeneration,
  evidenceFromPackDataRoutes,
  evidenceFromReview,
  evidenceFromSelectors,
  evidenceFromValidation,
} from "./evidence-from.ts";
export {
  agentClaimInvalidatedBy,
  confidenceRank,
  observationConflictIn,
  preferredEvidence,
} from "./evidence-precedence.ts";
export { SIDEKICK_AUTHORITY, type SidekickAuthority } from "./authority.ts";
export {
  createDelegationBrief,
  type ArtifactReference,
  type DelegationBrief,
  type DelegationScope,
  type ValidationStep,
} from "./delegation-brief.ts";
export {
  belongsToBrief,
  DELEGATION_RECOMMENDATIONS,
  DELEGATION_STATUSES,
  type DelegationRecommendation,
  type DelegationResult,
  type DelegationStatus,
  type FileChange,
} from "./delegation-result.ts";
export {
  ACCEPTANCE_REPORT_DEFECTS,
  ACCEPTANCE_STATUSES,
  readAcceptanceReport,
  type AcceptanceReport,
  type AcceptanceReportDefect,
  type AcceptanceReportDefectReason,
  type AcceptanceReportEntry,
  type AcceptanceStatus,
} from "./acceptance-report.ts";
export {
  classifyDelegationFailure,
  DELEGATION_FAILURE_CLASSES,
  type DelegationFailureClass,
} from "./delegation-failure-class.ts";
export {
  EXPLORE_FINDING_KIND,
  EXPLORE_STATUS,
  MAX_FINDINGS,
  type Exploration,
  type ExploreFinding,
  type ExploreFindingKind,
} from "./exploration.ts";
export { admitExploreRequest, EXPLORE_BUDGET_MS, EXPLORE_REJECTED, MAX_EXPLORE_QUESTIONS, type AdmittedExploreRequest, type ExploreQuestion } from "./explore-request.ts";
export { FINDING_VERIFICATION, verifyExplorationFindings, type ExplorationGround, type VerifiedFinding } from "./explore-verification.ts";
export { openKindSession } from "./kind-session.ts";
export { authorTask } from "./author-task.ts";
export { assembleSidekickBrief, renderSidekickBrief } from "./sidekick-prompt.ts";
export { assembleExploreBrief } from "./explore-kind.ts";
export { assembleLeadReview } from "./lead-review.ts";
export { assembleLeadCorrection, assembleRefusedCorrection } from "./lead-correction.ts";
export { assembleExploreOutcome } from "./explore-round.ts";
export { assembleRejectedPlanRequest } from "./lead-plan.ts";
export { COORDINATION_PROMPTS, type CoordinationPromptId } from "./coordination-sections/index.ts";
export {
  AGENT_TOOL,
  AUTHOR_TARGET,
  REGISTERED_SIDEKICK_KINDS,
  SIDEKICK_BUDGET,
  SIDEKICK_KIND,
  SIDEKICK_TIER,
  SIDEKICK_WORKSPACE,
  authorTargetSpec,
  delegatingKindSpec,
  sidekickKindSpec,
  type AgentTool,
  type AuthorTarget,
  type AuthorTargetSpec,
  type DelegatingKindSpec,
  type ReviewKindSpec,
  type SidekickKind,
  type SidekickKindSpec,
  type SidekickTier,
} from "./sidekick-kinds.ts";
export {
  SidekickExecutor,
  type SidekickExecuteOpts,
  type SidekickExecutorDeps,
  type SidekickRender,
} from "./sidekick-executor.ts";
export {
  applyPushback,
  PUSHBACK_REASONS,
  validateDelegationAuthority,
  type PushbackFinding,
  type PushbackReason,
} from "./pushback.ts";
export { isPathWithinWritableRoots } from "./path-scope.ts";
export { resolveSidekickModel } from "./resolve-sidekick-model.ts";
export {
  CoordinationTelemetryRecorder,
  type CoordinationTelemetryEvent,
  type CoordinationTelemetryKind,
  type LeadDecisionAction,
  type CoordinationTelemetryPort,
} from "./coordination-telemetry.ts";
export { CORRECTION_ORIGIN } from "./lead-correction.ts";
export type { CorrectionFinding, CorrectionOrigin } from "./lead-correction.ts";
export { LeadSidekicks } from "./lead-sidekicks.ts";
export type { CoordinateResult, CoordinatedPass, FlowCandidates } from "./lead-sidekicks.ts";

export { authorTargetOf, dispatchAuthor, type AuthorRequest, type RunAuthorTarget } from "./author-dispatch.ts";
