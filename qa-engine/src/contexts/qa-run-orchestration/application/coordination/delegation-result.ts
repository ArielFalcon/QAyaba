import type { EvidenceRef } from "./evidence-ref.ts";

export const DELEGATION_STATUSES = [
  "completed",
  "completed-with-concerns",
  "blocked",
  "needs-lead",
  "failed",
] as const;
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];

export const DELEGATION_RECOMMENDATIONS = ["accept", "review", "retry", "escalate"] as const;
export type DelegationRecommendation = (typeof DELEGATION_RECOMMENDATIONS)[number];

export interface FileChange {
  readonly path: string;
}

export interface DelegationResult {
  readonly delegationId: string;
  readonly runId: string;
  readonly status: DelegationStatus;
  readonly summary: string;
  readonly filesChanged: readonly FileChange[];
  readonly evidence: readonly EvidenceRef[];
  readonly validation: readonly { readonly id: string; readonly ok: boolean }[];
  readonly assumptions: readonly string[];
  readonly concerns: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly recommendation: DelegationRecommendation;
}

export function belongsToBrief(result: DelegationResult, delegationId: string, runId: string): boolean {
  return result.delegationId === delegationId && result.runId === runId;
}
