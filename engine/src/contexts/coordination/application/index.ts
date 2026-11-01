export { COORDINATION_ACTIONS, type CoordinationAction } from "./coordination-decision.ts";
export type { AcceptanceCriterion } from "./coordination-context.ts";
export type { EvidenceConfidence, EvidenceKind, EvidenceRef } from "./evidence-ref.ts";
export {
  evidenceFromEmptyRead,
  evidenceFromPackDataRoutes,
} from "./evidence-from.ts";
export {
  observationConflictIn,
} from "./evidence-precedence.ts";
export { SIDEKICK_AUTHORITY, type SidekickAuthority } from "./authority.ts";
export {
  createDelegationBrief,
  type ArtifactReference,
  type DelegationBrief,
  type DelegationScope,
} from "./delegation-brief.ts";
export {
  belongsToBrief,
  DELEGATION_STATUSES,
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
export { authorTask } from "./author-task.ts";
export { assembleSidekickBrief, renderSidekickBrief } from "./sidekick-prompt.ts";
export { assembleLeadReview } from "./lead-review.ts";
export { assembleReplanRequest } from "./plan-coverage.ts";
export { assembleSidekickFeedback } from "./sidekick-executor.ts";
export { assembleLeadCorrection, assembleRefusedCorrection } from "./lead-correction.ts";
export { COORDINATION_PROMPTS } from "./coordination-sections/index.ts";
export {
  AGENT_TOOL,
  AUTHOR_TARGET,
  REGISTERED_SIDEKICK_KINDS,
  SIDEKICK_BUDGET,
  SIDEKICK_KIND,
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
export {
  CoordinationTelemetryRecorder,
  type CoordinationTelemetryEvent,
  type CoordinationTelemetryKind,
  type CoordinationLedgerEvent,
  type CoordinationLedgerView,
  type LeadDecisionAction,
  type CoordinationTelemetryPort,
} from "./coordination-telemetry.ts";
export { CORRECTION_ORIGIN } from "./lead-correction.ts";
export type { CorrectionFinding, CorrectionOrigin } from "./lead-correction.ts";
export { LeadSidekicks } from "./lead-sidekicks.ts";
export type { CoordinateResult, CoordinatedPass, FlowCandidates } from "./lead-sidekicks.ts";

export { authorTargetOf, dispatchAuthor, type AuthorRequest, type RunAuthorTarget } from "./author-dispatch.ts";
