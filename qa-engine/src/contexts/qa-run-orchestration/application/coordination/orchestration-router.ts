/* Deterministic orchestration router. Returns OrchestrationDecision — distinct from CoordinationDecision (assignment). */
import { createHash } from "node:crypto";
import type { AgentCapability } from "./agent-capability.ts";
import { agentClaimInvalidatedBy } from "./evidence-precedence.ts";
import type { EvidenceRef } from "./evidence-ref.ts";

export interface ProgressSnapshot {
  readonly failureFingerprint: string;
  readonly changedFilesFingerprint?: string;
  readonly selectorFingerprint?: string;
  readonly coverageFingerprint?: string;
  readonly mutationFingerprint?: string;
}

export function fingerprintOf(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

export function buildProgressSnapshot(input: {
  failureClass?: string;
  failingNames?: readonly string[];
  changedFiles?: readonly string[];
  selectorContradictions?: readonly string[];
  coverageStatus?: string;
  mutationSignal?: string;
}): ProgressSnapshot {
  return {
    failureFingerprint: fingerprintOf([
      input.failureClass ?? "",
      ...(input.failingNames ?? []).slice().sort(),
    ]),
    ...(input.changedFiles
      ? { changedFilesFingerprint: fingerprintOf([...input.changedFiles].sort()) }
      : {}),
    ...(input.selectorContradictions
      ? { selectorFingerprint: fingerprintOf([...input.selectorContradictions].sort()) }
      : {}),
    ...(input.coverageStatus ? { coverageFingerprint: fingerprintOf([input.coverageStatus]) } : {}),
    ...(input.mutationSignal ? { mutationFingerprint: fingerprintOf([input.mutationSignal]) } : {}),
  };
}

export function sameProgress(a: ProgressSnapshot, b: ProgressSnapshot): boolean {
  return (
    a.failureFingerprint === b.failureFingerprint &&
    a.changedFilesFingerprint === b.changedFilesFingerprint &&
    a.selectorFingerprint === b.selectorFingerprint &&
    a.coverageFingerprint === b.coverageFingerprint &&
    a.mutationFingerprint === b.mutationFingerprint
  );
}

export const ORCHESTRATION_ACTIONS = [
  "accept",
  "retry-sidekick",
  "escalate-sidekick",
  "lead-takeover",
  "abort-human",
  "continue-fix-loop",
] as const;
export type OrchestrationAction = (typeof ORCHESTRATION_ACTIONS)[number];

export interface OrchestrationDecision {
  readonly action: OrchestrationAction;
  readonly reason: string;
  readonly evidence: readonly EvidenceRef[];
  readonly nextCapability?: AgentCapability;
}

export interface RouterInput {
  readonly evidence: readonly EvidenceRef[];
  readonly currentCapability: AgentCapability;
  readonly previous?: ProgressSnapshot;
  readonly current: ProgressSnapshot;
  readonly budgetExhausted: boolean;
  readonly infraFailure: boolean;
  readonly sidekickNeedsLead?: boolean;
  readonly qaCorrectionOwnedByFixLoop?: boolean;
}

export function routeOrchestration(input: RouterInput): OrchestrationDecision {
  const { evidence } = input;
  if (input.infraFailure) {
    return { action: "abort-human", reason: "hard infrastructure failure", evidence };
  }
  if (input.budgetExhausted) {
    return { action: "abort-human", reason: "hard budget exhausted", evidence };
  }
  const contradiction = agentClaimInvalidatedBy(evidence);
  if (contradiction) {
    return {
      action: "lead-takeover",
      reason: `deterministic contradiction: ${contradiction.summary}`,
      evidence,
      nextCapability: "lead",
    };
  }
  if (input.previous && sameProgress(input.previous, input.current)) {
    if (input.currentCapability === "sidekick-standard") {
      return {
        action: "escalate-sidekick",
        reason: "no progress at sidekick-standard",
        evidence,
        nextCapability: "sidekick-escalated",
      };
    }
    if (input.currentCapability === "sidekick-escalated") {
      return {
        action: "lead-takeover",
        reason: "no progress at sidekick-escalated",
        evidence,
        nextCapability: "lead",
      };
    }
    return {
      action: "continue-fix-loop",
      reason: "no progress — return control to existing FixLoop",
      evidence,
    };
  }
  if (input.sidekickNeedsLead) {
    return {
      action: "lead-takeover",
      reason: "sidekick emitted needs-lead",
      evidence,
      nextCapability: "lead",
    };
  }
  if (input.qaCorrectionOwnedByFixLoop) {
    return {
      action: "continue-fix-loop",
      reason: "QA correction validity owned by FixLoop",
      evidence,
    };
  }
  if (input.currentCapability.startsWith("sidekick")) {
    return {
      action: "retry-sidekick",
      reason: "recoverable by same capability",
      evidence,
      nextCapability: input.currentCapability,
    };
  }
  return { action: "accept", reason: "lead path acceptable", evidence };
}
