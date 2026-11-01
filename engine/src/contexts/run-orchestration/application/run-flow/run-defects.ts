/* The defects the run's facts establish with no failing test: a contradiction the provider's contract lacks, on a page or operation the change reaches. Shared by the coverage gap, which tells them to the lead, and the decision, which ends a green run on them. */
import { namesTemplatePage } from "@contexts/generation/application/index.ts";
import { contradictionDefects, type CausalMatchers } from "@contexts/objective-signal/application/index.ts";
import { requestServesOperation } from "@contexts/service-topology/application/index.ts";
import type { DefectFact } from "@kernel/data-contradiction.ts";
import type { RunContext } from "./run-context.ts";
import type { RunState } from "./run-state.ts";

export const REACH_MATCHERS: CausalMatchers = { servesOperation: requestServesOperation, namesPage: namesTemplatePage };

/* The defects the run's facts establish with no failing test: a contradiction the provider's contract lacks, on a page or operation the change reaches. A run that generated nothing, or a context run, found none. */
export function defectsOf(state: Readonly<RunState>, ctx: Pick<RunContext, "input">): DefectFact[] {
  if (!state.classification.generating || ctx.input.mode === "context") return [];
  return contradictionDefects({ facts: state.grounding.dataContradictions?.facts ?? [], scope: state.grounding.changeScope, matchers: REACH_MATCHERS });
}
