/*
 * The run author's deliverable as the submit tool carries it. The wire schema fixes the field names and types the tool's arguments
 * are generated from; the reader schema (`GeneratorVerdictSchema`) judges the call: an empty specs list that carries no decision is
 * returned to the author inside its turn with where it went wrong, and the accepted call is the verdict.
 */

import { z } from "zod";
import { NOOP_KIND } from "@kernel/noop-kind.ts";
import { SUBMIT_TOOL, submissionErrorsOf, type SubmissionContract, type SubmissionError } from "@kernel/submission.ts";
import { GeneratorVerdictSchema, MISSING_DECISION_PATH, RebuttalSchema, SpecMetaSchema, TestCorrectSchema } from "./verdict-schemas.ts";

export const GENERATOR_VERDICT_WIRE = z.object({
  specs: z.array(z.string()).describe("The suite-relative paths of the spec files you wrote or changed. [] only with noop, testCorrect or rebuttals."),
  specMetas: z.array(SpecMetaSchema).optional().describe("One entry per spec: its file, flow, objective and the code it targets."),
  note: z.string().optional(),
  noop: z
    .object({
      kind: z.enum([NOOP_KIND.NOT_WORTH, NOOP_KIND.UNOBSERVABLE]).optional().describe("not-worth: nothing in the change is worth an E2E test. unobservable: DEV cannot show the changed behavior in its current state."),
      reason: z.string().describe("Why nothing was written."),
    })
    .optional()
    .describe("The decision to write no spec, with its reason."),
  testCorrect: TestCorrectSchema.optional().describe("Only when you hold a failing test right and the application or the environment wrong."),
  rebuttals: z.array(RebuttalSchema).optional().describe("The findings you dispute instead of correcting, each with the evidence the orchestrator can check."),
});

export const generatorVerdictContract: SubmissionContract<Record<string, unknown>> = {
  tool: SUBMIT_TOOL.SPECS,
  check: (answer) => {
    const read = GeneratorVerdictSchema.safeParse(answer);
    return read.success ? { ok: true, value: answer as Record<string, unknown> } : { ok: false, errors: submissionErrorsOf(read.error) };
  },
};

/** Whether the rejections a turn ended on were all the refusal of an empty verdict that decides nothing: silence, which the generation classifies as an undecided end rather than a lost answer. */
export function endedOnMissingDecision(errors: readonly SubmissionError[]): boolean {
  return errors.length > 0 && errors.every((error) => error.path === MISSING_DECISION_PATH);
}
