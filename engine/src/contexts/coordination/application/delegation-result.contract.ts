/*
 * A sidekick's result as the submit tool carries it. The wire schema fixes the field names and types the tool's arguments are
 * generated from; the reader (`submittedResultErrors`) judges the call: an entry it cannot read is returned to the sidekick inside
 * its turn with where it went wrong. The brief's identity is the orchestrator's, so the tool carries none.
 */

import { z } from "zod";
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import { SUBMIT_TOOL, type SubmissionContract } from "@kernel/submission.ts";
import { ACCEPTANCE_STATUSES, UNMET_CAUSES } from "./acceptance-report.ts";
import type { DelegationBrief } from "./delegation-brief.ts";
import { submittedResultErrors } from "./delegation-reading.ts";
import { CANDIDATE_CLAIMS, DELEGATION_STATUSES } from "./delegation-result.ts";

export const DELEGATION_RESULT_WIRE = z.object({
  status: z.enum(DELEGATION_STATUSES).describe("completed, completed-with-concerns, blocked, needs-lead or failed."),
  summary: z.string().describe("What you did and what came of it."),
  filesChanged: z.array(z.object({ path: z.string() })).describe("The files you wrote or changed."),
  acceptance: z
    .array(
      z.object({
        criterion: z.number().int().describe("The criterion's number, as the brief lists it, from 1."),
        status: z.enum(ACCEPTANCE_STATUSES).describe("met only when you checked it holds, unmet when your work does not satisfy it, unverified when you could not check it."),
        note: z.string().optional(),
        cause: z.literal(UNMET_CAUSES.DEV_STATE).optional().describe("With unmet: DEV's state prevents the criterion, as pages you read in this turn show."),
        pages: z.array(z.string()).optional().describe("With cause dev-state: the paths of the pages you read."),
      }),
    )
    .describe("One entry for every numbered acceptance criterion; empty when there are none."),
  candidates: z
    .array(
      z.object({
        id: z.string().describe("The id of a use case of the Change section."),
        status: z.enum(CANDIDATE_CLAIMS).describe("covered when a test of yours exercises it, not-covered when none does, blocked when you could not."),
        spec: z.string().optional().describe("The title of the test that covers it."),
      }),
    )
    .optional()
    .describe("One entry for every use case of the Change section, when the brief lists any."),
  testCorrect: z
    .object({ cause: z.enum(["env", "app"]), reason: z.string() })
    .optional()
    .describe("Only when you hold a failing test right and the application or the environment wrong."),
  concerns: z.array(z.string()).optional().describe("Notes; only an unmet acceptance entry reports a failure."),
  unresolvedQuestions: z.array(z.string()).optional(),
});

export function delegationResultContract(brief: DelegationBrief, redaction: RedactionPort): SubmissionContract<Record<string, unknown>> {
  return {
    tool: SUBMIT_TOOL.RESULT,
    check: (answer) => {
      const errors = submittedResultErrors(answer, brief, redaction);
      return errors.length === 0 ? { ok: true, value: answer as Record<string, unknown> } : { ok: false, errors };
    },
  };
}
