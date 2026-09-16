// Minimal lead context (Fase 10). Derivable from artifacts — never a second OpencodeRunInput.
import type { AcceptanceCriterion } from "./coordination-context.ts";
import type { CoordinationDecision } from "./coordination-decision.ts";
import type { EvidenceRef } from "./evidence-ref.ts";

export interface DelegationSummary {
  readonly delegationId: string;
  readonly status: string;
  readonly summary: string;
}

export interface LeadContext {
  readonly runId: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly decisions: readonly CoordinationDecision[];
  readonly delegations: readonly DelegationSummary[];
  readonly evidence: readonly EvidenceRef[];
  readonly unresolvedQuestions: readonly string[];
}

export function createLeadContext(input: {
  runId: string;
  objective: string;
  acceptanceCriteria?: readonly AcceptanceCriterion[];
}): LeadContext {
  return {
    runId: input.runId,
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    decisions: [],
    delegations: [],
    evidence: [],
    unresolvedQuestions: [],
  };
}

export function appendLeadDecision(ctx: LeadContext, decision: CoordinationDecision): LeadContext {
  return { ...ctx, decisions: [...ctx.decisions, decision], evidence: [...ctx.evidence, ...decision.evidence] };
}

export function appendLeadDelegation(ctx: LeadContext, summary: DelegationSummary): LeadContext {
  return { ...ctx, delegations: [...ctx.delegations, summary] };
}

export function appendLeadQuestions(ctx: LeadContext, questions: readonly string[]): LeadContext {
  return { ...ctx, unresolvedQuestions: [...ctx.unresolvedQuestions, ...questions] };
}
