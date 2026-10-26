/*
 * What a plan's flows add up to. Pure: the run reads the answer the way it reads the end of any generation, so a fan-out is not a
 * new kind of ending. One delivered flow is a delivery and the flows that did not finish are carried beside it; with nothing
 * delivered, only flows that all said why they wrote nothing are a decision (a declared no-op); a flow out of time ends the run on
 * its time budget; anything else is no decision, because silence is not one.
 */

import { GENERATION_END, type GenerationEndKind } from "@kernel/generation-end.ts";
import { GENERATION_NOTE_MAX_CHARS } from "@contexts/generation/application/index.ts";

export const FLOW_OUTCOME = {
  DELIVERED: "delivered",
  DECLINED: "declined",
  TIMED_OUT: "timed-out",
  NEEDS_LEAD: "needs-lead",
  FAILED: "failed",
} as const;
export type FlowOutcomeKind = (typeof FLOW_OUTCOME)[keyof typeof FLOW_OUTCOME];

export interface FlowOutcome {
  id: string;
  kind: FlowOutcomeKind;
  /* The spec files a delivered flow wrote, relative to the spec directory. */
  specs?: string[];
  /* Why a declined flow wrote nothing, or what went wrong with a flow that did not finish. */
  reason?: string;
}

export interface IncompleteFlow {
  id: string;
  kind: FlowOutcomeKind;
  reason?: string;
}

export interface AggregatedFlows {
  end: GenerationEndKind;
  specs: string[];
  incompleteFlows: IncompleteFlow[];
  note?: string;
}

function bounded(text: string): string {
  return text.length <= GENERATION_NOTE_MAX_CHARS ? text : `${text.slice(0, GENERATION_NOTE_MAX_CHARS - 1)}…`;
}

function describe(outcomes: readonly FlowOutcome[]): string {
  return outcomes.map((outcome) => `${outcome.id}: ${outcome.kind}${outcome.reason ? ` (${outcome.reason})` : ""}`).join("; ");
}

/* A flow that says it delivered and names no spec delivered nothing. */
function honest(outcome: FlowOutcome): FlowOutcome {
  return outcome.kind === FLOW_OUTCOME.DELIVERED && (outcome.specs?.length ?? 0) === 0
    ? { id: outcome.id, kind: FLOW_OUTCOME.FAILED, reason: "reported a delivery and named no spec" }
    : outcome;
}

export function aggregateFlowOutcomes(reported: readonly FlowOutcome[]): AggregatedFlows {
  const outcomes = reported.map(honest);
  const deliveredFlows = outcomes.filter((outcome) => outcome.kind === FLOW_OUTCOME.DELIVERED);
  const incompleteFlows = outcomes
    .filter((outcome) => outcome.kind !== FLOW_OUTCOME.DELIVERED && !isDecision(outcome))
    .map((outcome) => ({ id: outcome.id, kind: outcome.kind, ...(outcome.reason ? { reason: outcome.reason } : {}) }));

  if (deliveredFlows.length > 0) {
    const specs = [...new Set(deliveredFlows.flatMap((outcome) => outcome.specs ?? []))];
    return { end: GENERATION_END.DELIVERED, specs, incompleteFlows };
  }
  if (outcomes.length > 0 && outcomes.every(isDecision)) {
    return { end: GENERATION_END.DECLARED_NOOP, specs: [], incompleteFlows: [], note: bounded(describe(outcomes)) };
  }
  const end = outcomes.some((outcome) => outcome.kind === FLOW_OUTCOME.TIMED_OUT) ? GENERATION_END.TIME_BUDGET : GENERATION_END.UNDECIDED_EMPTY;
  return { end, specs: [], incompleteFlows, note: bounded(outcomes.length === 0 ? "the plan's flows left nothing to aggregate" : describe(outcomes)) };
}

/* A flow that wrote nothing and said why. */
function isDecision(outcome: FlowOutcome): boolean {
  return outcome.kind === FLOW_OUTCOME.DECLINED && (outcome.reason?.trim() ?? "") !== "";
}
