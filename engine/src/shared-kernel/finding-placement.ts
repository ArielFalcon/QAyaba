import type { DropBasis } from "./drop-basis.ts";

/* The fact that sent a finding of a correction turn to its flow: the spec it cites or names, the spec that evaluated what it is about, the use case its file seeds, the lead's order, or a flow the orchestrator opened for it. */
export type FindingPlacementFact = "spec" | "evaluator" | "candidate" | "lead" | "opened";

/* Where one finding of a correction turn went; empty when no flow was sent it. A finding the lead declined went to no flow: its basis, and the fact that contradicts it when the run's facts do (the decline stands all the same). */
export interface FindingPlacement {
  flowId?: string;
  by?: FindingPlacementFact;
  declined?: { basis: DropBasis; contradicted?: string };
}
