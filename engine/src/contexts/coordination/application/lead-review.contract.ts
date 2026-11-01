/*
 * The lead's review of the flows as the submit tool carries it. The wire schema fixes the field names and types the tool's arguments
 * are generated from; the reader (`admitLeadReview`) judges the call: an answer or an entry it cannot read is returned to the lead
 * inside the turn with where it went wrong. What the orchestrator's facts then do with a readable decision is the admission's, not a
 * reason to refuse the call.
 */

import { z } from "zod";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { SUBMIT_TOOL, type SubmissionContract } from "@kernel/submission.ts";
import { admitLeadReview, REVIEW_ACTIONS, type FlowUnderReview } from "./lead-review.ts";

export const LEAD_REVIEW_WIRE = z.object({
  review: z
    .array(
      z.object({
        flow: z.string().describe("The id of the flow this decision is about."),
        action: z.enum(REVIEW_ACTIONS as [string, ...string[]]).describe("accept, revise (needs an instruction), replace, or drop (a flow that delivered nothing, with a reason)."),
        instruction: z.string().optional().describe("With revise or replace: what to change. Be specific: name the assertion, the page or the fact to fix."),
        reason: z.string().optional().describe("With drop: why."),
      }),
    )
    .describe("One decision per flow; a flow you do not name stays as it is."),
});

export function leadReviewContract(redaction: RedactionPort, flows: readonly FlowUnderReview[], opts: { revisionsAllowed: boolean }): SubmissionContract<Record<string, unknown>> {
  return {
    tool: SUBMIT_TOOL.FLOW_REVIEW,
    check: (answer) => {
      const admission = admitLeadReview(redaction, answer, flows, opts);
      if (admission.readable && admission.unreadable.length === 0) return { ok: true, value: answer as Record<string, unknown> };
      return { ok: false, errors: admission.unreadable.map((entry) => ({ path: entry.where, reason: entry.reason })) };
    },
  };
}
