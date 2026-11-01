/*
 * The reviewer's verdict as the submit tool carries it. The wire schema fixes the field names and types the tool's arguments are
 * generated from; the reader (`readReviewerVerdict`) judges the call: a verdict it cannot read whole is returned to the reviewer
 * inside its turn with where it went wrong, and the accepted call is the verdict.
 */

import { z } from "zod";
import { SUBMIT_TOOL, type SubmissionContract } from "@kernel/submission.ts";
import { CorrectionEntrySchema } from "./verdict-schemas.ts";
import { readReviewerVerdict, type ReviewerVerdict } from "./verdict-validate.ts";

export const REVIEWER_VERDICT_WIRE = z.object({
  approved: z.boolean().describe("true when these specs may be published as they are, false when a correction must be made first."),
  rationale: z.string().optional().describe("One or two sentences, on approval too: what these tests do or fail to do about the change."),
  corrections: z.array(CorrectionEntrySchema).describe("The findings, blocking first. [] beside an approval is a complete answer."),
});

export const reviewerVerdictContract: SubmissionContract<ReviewerVerdict> = {
  tool: SUBMIT_TOOL.REVIEW,
  check: (answer) => {
    const verdict = readReviewerVerdict(answer);
    return verdict.valid ? { ok: true, value: verdict } : { ok: false, errors: verdict.issues };
  },
};
