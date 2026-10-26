/* The specs a run has delivered, kept up to date pass by pass so that every regeneration can be told which specs the run wrote. Pure. An author pass is the agent that writes the specs of the run itself: it delivers them with the flow and objective it declared for each, and its newest declared text wins. A sidekick pass delivers paths only: the objective a delegation carries is the delegation's own, never the spec's, so it is neither stored nor allowed to clear or replace an objective an author declared. Entries keep the order each spec first appeared in. */
import { upsertDeliveredSpec, type DeliveredSpec } from "@kernel/delivered-spec.ts";

/** Who wrote the specs of a pass. */
export type DeliveryOrigin = "author" | "sidekick";

/** What a generation pass hands back that the run carries forward: the specs it delivered and, from an author, what it declared for them. */
export interface DeliveredPass {
  specs: readonly string[];
  declaredSpecs?: readonly DeliveredSpec[];
}

export function mergeDeliveredSpecs(delivered: readonly DeliveredSpec[], pass: DeliveredPass, origin: DeliveryOrigin): DeliveredSpec[] {
  /* Every spec the pass reports is delivered, declared or not; an author then refreshes each with what it declared. */
  const paths = pass.specs.map((file) => ({ file }));
  const contributions = origin === "author" ? [...paths, ...(pass.declaredSpecs ?? [])] : paths;
  return contributions.reduce((entries, contribution) => upsertDeliveredSpec(entries, contribution), [...delivered]);
}
