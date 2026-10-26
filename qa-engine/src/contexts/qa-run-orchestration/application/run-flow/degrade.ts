/*
 * Where a run goes on from a step whose fault the policy degrades. A spent deadline in a step that runs after a suite was proven
 * keeps what is proven: the run goes to the final proof guard, which fails closed unless every delivered spec still has proof for
 * its bytes, and then decides. The one thing the deadline can take is the approval: a review the run requires that has not given
 * its verdict proves nothing about approval, so the run ends on the deadline as it always did. Pure over the state it reads.
 */

import { goto, type StepOutcome } from "./run-flow.ts";
import type { DegradeReason } from "./failure-policy.ts";
import type { EndReason } from "./end-reason.ts";
import type { RunEnd } from "./run-end.ts";
import type { RunState } from "./run-state.ts";
import type { StepId } from "./step-ids.ts";

/** The step the run goes on from after a degraded fault: the guard that decides whether what is proven can be kept. */
const KEEP_PROVEN_AT: StepId = "guard-final-proof";

/** What a run that kept its proven suite past a spent deadline says on its outcome. */
export const deadlineNote = (stepId: StepId): string => `the run deadline was spent during ${stepId}; the suite that ran green on its final bytes is kept`;

export interface DegradeFacts {
  /** The run requires a review of its tests. */
  reviewRequired: boolean;
  /** The end a fault that cannot be degraded past is turned into. */
  endOf(reason: EndReason, err: unknown): RunEnd;
}

export function degradeFailedStep(reason: DegradeReason, err: unknown, stepId: StepId, state: Readonly<RunState>, facts: DegradeFacts): StepOutcome<RunState> {
  /* The publication effect degrades inside finalizeRun, which asks the policy itself: no step of the table reaches this with another reason. */
  if (reason !== "deadline-after-proof") throw err;
  if (facts.reviewRequired && state.review.reviewerApprovedForOutcome === undefined) {
    return { end: facts.endOf("run-deadline", err) };
  }
  return goto(KEEP_PROVEN_AT, { degraded: [...state.degraded, { reason, note: deadlineNote(stepId) }] });
}
