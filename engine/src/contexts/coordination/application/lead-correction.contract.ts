/*
 * The lead's routing of the findings as the submit tool carries it. The wire schema fixes the field names and types the tool's
 * arguments are generated from; the reader (`admitLeadCorrection`) judges the call: an answer, an order or a rebuttal it cannot read
 * is returned to the lead inside the turn with where it went wrong. What the orchestrator's facts then refuse or leave unrouted is
 * the admission's, not a reason to refuse the call.
 */

import { z } from "zod";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { SUBMIT_TOOL, type SubmissionContract } from "@kernel/submission.ts";
import { REVIEW_ACTION } from "./lead-review.ts";
import { admitLeadCorrection, CORRECTION_ORIGIN, type CorrectionFinding, type CorrectionOrigin, type FlowUnderCorrection } from "./lead-correction.ts";

export const LEAD_CORRECTION_WIRE = z.object({
  corrections: z
    .array(
      z.object({
        flow: z.string().describe("The id of the flow that corrects."),
        action: z.enum([REVIEW_ACTION.REVISE, REVIEW_ACTION.REPLACE]).describe("revise sends your instruction and the flow's findings to the same sidekick; replace starts a fresh sidekick on the same flow, for one that is stuck."),
        findings: z.array(z.number().int()).optional().describe("The numbers of the findings that cite no flow, or that you move to this flow, exactly as the list numbers them. A finding citing a flow's spec is always sent to it."),
        instruction: z.string().optional().describe("What to change."),
      }),
    )
    .optional()
    .describe("One order per flow that corrects."),
  rebuttals: z
    .array(
      z.object({
        finding: z.number().int().describe("The number of the finding you hold to be wrong, exactly as the list numbers it."),
        basis: z.enum(["execution", "contract"]).describe("execution: a test of this run that passed on the current bytes; contract: a clause that still holds."),
        ref: z.string().describe("The test or the clause."),
        reason: z.string().optional().describe("Why the finding is wrong."),
      }),
    )
    .optional()
    .describe("Only when the findings are the independent reviewer's; leave it out when they are facts the run observed."),
});

export function leadCorrectionContract(
  redaction: RedactionPort,
  flows: readonly FlowUnderCorrection[],
  findings: readonly CorrectionFinding[],
  origin: CorrectionOrigin = CORRECTION_ORIGIN.REVIEW,
): SubmissionContract<Record<string, unknown>> {
  return {
    tool: SUBMIT_TOOL.CORRECTIONS,
    check: (answer) => {
      const admission = admitLeadCorrection(redaction, answer, flows, findings, origin);
      if (admission.readable && admission.unreadable.length === 0) return { ok: true, value: answer as Record<string, unknown> };
      return { ok: false, errors: admission.unreadable.map((entry) => ({ path: entry.where, reason: entry.reason })) };
    },
  };
}
