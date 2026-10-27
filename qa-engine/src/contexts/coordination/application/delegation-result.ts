import type { AcceptanceReportDefect, AcceptanceReportEntry } from "./acceptance-report.ts";
import type { EvidenceRef } from "./evidence-ref.ts";
import type { Exploration } from "./exploration.ts";
import type { UNREADABLE_ANSWER } from "@kernel/unreadable-answer.ts";

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

export const CANDIDATE_CLAIMS = ["covered", "not-covered", "blocked"] as const;
export type CandidateClaimStatus = (typeof CANDIDATE_CLAIMS)[number];

/* A sidekick's claim about one use case of its brief: what it says it did, not what the orchestrator saw. */
export interface CandidateClaim {
  readonly id: string;
  readonly status: CandidateClaimStatus;
  /* The title of the test that covers it, as the sidekick wrote it. */
  readonly spec?: string;
}

/* An unmet criterion DEV's state prevents, with the pages the sidekick named and the fact of the orchestrator's that backs the claim. */
export interface UnmetByDevState {
  readonly criterion: number;
  readonly pages: readonly string[];
  readonly backing: string;
}

export interface FileChange {
  readonly path: string;
}

export interface DelegationResult {
  readonly delegationId: string;
  readonly runId: string;
  readonly status: DelegationStatus;
  readonly summary: string;
  readonly filesChanged: readonly FileChange[];
  /** The orchestrator's own facts about the answer (why it could not be read); never the sidekick's. */
  readonly evidence?: readonly EvidenceRef[];
  readonly concerns: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly recommendation: DelegationRecommendation;
  /** Per-criterion report, keyed by the brief's 1-based criterion numbers; only well-formed entries. */
  readonly acceptance: readonly AcceptanceReportEntry[];
  /** The sidekick's claim per use case its brief listed; only well-formed entries for ids the brief carried. */
  readonly candidates?: readonly CandidateClaim[];
  /** Set when the report is absent or malformed: every criterion without a kept entry is unverified. */
  readonly acceptanceReportDefect?: AcceptanceReportDefect;
  /** The criteria the sidekick reports unmet because DEV's state prevents them and the orchestrator's own facts back; set by the orchestrator, never read from the sidekick's answer. */
  readonly unmetByDevState?: readonly UnmetByDevState[];
  /** The sidekick's claim, on a correction of a failing execution, that its test is right and the app or the environment is not. */
  /** An explore sidekick's findings, as it reported them: the orchestrator verifies each before the lead sees it. */
  readonly exploration?: Exploration;
  readonly testCorrect?: { readonly cause: "env" | "app"; readonly reason: string };
  /** Set when the output held no DelegationResult at all: the result is a failure the orchestrator inferred, not one the sidekick reported. */
  readonly readMiss?: typeof UNREADABLE_ANSWER;
  /** Set when the result is the orchestrator's own statement about an answer it could not take (unreadable, or addressed to another brief): its summary and concerns are the orchestrator's words, never the sidekick's. */
  readonly answerMiss?: AnswerMiss;
}

/** Why the orchestrator holds no answer of the sidekick's: the output held no DelegationResult, or the one it held answered a different brief. */
export const ANSWER_MISS = { UNREADABLE: "unreadable", FOREIGN_BRIEF: "foreign-brief" } as const;
export type AnswerMiss = (typeof ANSWER_MISS)[keyof typeof ANSWER_MISS];

export function belongsToBrief(result: DelegationResult, delegationId: string, runId: string): boolean {
  return result.delegationId === delegationId && result.runId === runId;
}
