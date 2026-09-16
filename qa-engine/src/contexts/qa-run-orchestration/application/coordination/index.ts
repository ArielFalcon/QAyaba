export { AGENT_CAPABILITIES, isAgentCapability, type AgentCapability } from "./agent-capability.ts";
export {
  COORDINATION_ACTIONS,
  isCoordinationAction,
  type CoordinationAction,
  type CoordinationDecision,
} from "./coordination-decision.ts";
export {
  COORDINATION_MODES,
  resolveCoordinationMode,
  type CoordinationMode,
} from "./coordination-mode.ts";
export { createCoordinationPort } from "./create-coordination-port.ts";
export type { CoordinationBudget } from "./coordination-budget.ts";
export type { AcceptanceCriterion, CoordinationContext } from "./coordination-context.ts";
export type { EvidenceConfidence, EvidenceKind, EvidenceRef } from "./evidence-ref.ts";
export type { CoordinationPort } from "../ports/coordination.port.ts";

export {
  evidenceFromBudget,
  evidenceFromChangeAnalysis,
  evidenceFromCoverage,
  evidenceFromExecution,
  evidenceFromFailureClass,
  evidenceFromFixLoop,
  evidenceFromGeneration,
  evidenceFromReview,
  evidenceFromSelectors,
  evidenceFromValidation,
} from "./evidence-from.ts";
export {
  agentClaimInvalidatedBy,
  confidenceRank,
  preferredEvidence,
} from "./evidence-precedence.ts";

export { SIDEKICK_AUTHORITY, type SidekickAuthority } from "./authority.ts";
export {
  createDelegationBrief,
  DEFAULT_ESCALATION_POLICY,
  type ArtifactReference,
  type DelegationBrief,
  type DelegationScope,
  type EscalationPolicy,
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
  PARALLEL_WORKER_MISSING_FOR_SIDEKICK,
  PARALLEL_WORKER_REUSABLE_FIELDS,
} from "./parallel-worker-reuse.ts";
export { renderSidekickBrief } from "./sidekick-prompt.ts";
export {
  resolveCapabilityRole,
  SidekickExecutor,
  type SidekickExecuteOpts,
  type SidekickExecutorDeps,
  type SidekickRender,
} from "./sidekick-executor.ts";

export {
  proposeFromDecision,
  type ProposedOrchestrationDecision,
} from "./proposed-orchestration-decision.ts";
export {
  COORDINATION_ACTIVE_POINTS,
  shouldHonorActiveDelegation,
  shouldHonorFixLoopSidekick,
  type CoordinationActivePoint,
} from "./active-gate.ts";
export { ProposingCoordinationAdapter } from "./proposing-coordination.adapter.ts";
export {
  applyPushback,
  PUSHBACK_REASONS,
  validateDelegationAuthority,
  type PushbackFinding,
  type PushbackReason,
} from "./pushback.ts";
export {
  buildProgressSnapshot,
  fingerprintOf,
  ORCHESTRATION_ACTIONS,
  routeOrchestration,
  sameProgress,
  type OrchestrationAction,
  type OrchestrationDecision,
  type ProgressSnapshot,
  type RouterInput,
} from "./orchestration-router.ts";
export {
  canRetrySameCapability,
  ESCALATION_LADDER,
  nextEscalation,
  raiseCapabilityFloor,
  advanceAfterNeedsLead,
} from "./escalation-ladder.ts";
export {
  appendLeadDecision,
  appendLeadDelegation,
  appendLeadQuestions,
  createLeadContext,
  type DelegationSummary,
  type LeadContext,
} from "./lead-context.ts";
export {
  InMemoryCoordinationTelemetry,
  type CoordinationTelemetryEvent,
  type CoordinationTelemetryPort,
} from "./coordination-telemetry.ts";
export { capabilityForFixLoopRound } from "./fix-loop-capability.ts";
export {
  classifyShadowDivergence,
  SHADOW_DIVERGENCE_CLASSES,
  type ShadowDivergenceClass,
} from "./shadow-divergence.ts";
export {
  DEFAULT_ADAPTIVE_POLICY,
  type AdaptiveRoutingPolicy,
  type AdaptiveRoutingSignals,
} from "./adaptive-routing.ts";
