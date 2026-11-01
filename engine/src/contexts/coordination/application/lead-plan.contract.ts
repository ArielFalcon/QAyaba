/*
 * The lead's plan as the submit tool carries it. The wire schema fixes the field names and types the tool's arguments are generated
 * from; the bounds, trims and tolerances stay with the reader (`admitLeadPlan`), which also judges the call: a plan it refuses as
 * unreadable is returned to the lead inside the turn, with where in the plan the reader met what it could not read.
 */

import { z } from "zod";
import { SUBMIT_TOOL, type SubmissionContract, type SubmissionError } from "@kernel/submission.ts";
import { describePlanRefusal, DROP_BASIS, LEAD_PLAN_KIND, PLAN_DOWNGRADE, PLAN_REJECTED, type AdmittedPlan } from "./lead-plan.ts";

const DROP_BASES = Object.values(DROP_BASIS) as [string, ...string[]];

const FlowWire = z.object({
  id: z.string().describe("A short slug naming the flow. It names the flow's spec file; no two flows share one."),
  objective: z.string().describe("What the flow proves."),
  acceptance: z.array(z.string()).optional().describe("One observable outcome per behaviour the change decides on the flow's pages: the outcome when it succeeds, and each other state the change handles there that the page can be brought to through the UI against DEV."),
  routes: z.array(z.string()).optional().describe("Site-relative paths the flow visits, each starting with /."),
  candidates: z.array(z.string()).optional().describe("Ids of the use cases the flow covers."),
  location: z.union([z.string(), z.object({ latitude: z.number(), longitude: z.number() })]).optional().describe("One of the app's locations by name, or a point, when the prompt lists the locations."),
});

const DropWire = z.object({
  candidate: z.string().describe("Id of a use case that needs no test."),
  basis: z.enum(DROP_BASES).describe("Why it needs none: no-observable-change, already-covered or needs-unavailable-state."),
  reason: z.string().describe("Why, in words."),
});

export const LEAD_PLAN_WIRE = z.object({
  kind: z.enum([LEAD_PLAN_KIND.FANOUT, LEAD_PLAN_KIND.NOOP]).describe("fanout when the change is one or more flows, each of which can be written and run without the others (a change that is one piece of work is a plan of one flow); noop when nothing here is worth a test."),
  reason: z.string().optional().describe("With noop: why nothing here is worth a test, or the element and the evidence showing the change cannot be observed on DEV in its current state."),
  dropped: z.array(DropWire).optional().describe("With fanout: the use cases the prompt lists that need no test, each with a basis and a reason. Leave it out when you drop none."),
  flows: z.array(FlowWire).optional().describe("With fanout: the flows to author."),
});

/* The refusals a lead can correct; the run's own time left is not one of them. */
const CORRECTABLE = new Set<string>([PLAN_DOWNGRADE.NO_PLAN, PLAN_DOWNGRADE.MALFORMED, PLAN_DOWNGRADE.EMPTY, PLAN_DOWNGRADE.DUPLICATE]);

function errorsOf(refused: Extract<AdmittedPlan, { kind: typeof PLAN_REJECTED }>): SubmissionError[] {
  if (refused.unreadable !== undefined && refused.unreadable.length > 0) return refused.unreadable.map((entry) => ({ path: entry.where, reason: entry.reason }));
  return [{ path: "plan", reason: describePlanRefusal(refused.downgrade, refused.detail) }];
}

export function leadPlanContract(admit: (answer: unknown) => AdmittedPlan): SubmissionContract<Record<string, unknown>> {
  return {
    tool: SUBMIT_TOOL.PLAN,
    check: (answer) => {
      const admitted = admit(answer);
      if (admitted.kind === PLAN_REJECTED && CORRECTABLE.has(admitted.downgrade)) return { ok: false, errors: errorsOf(admitted) };
      return { ok: true, value: answer as Record<string, unknown> };
    },
  };
}
