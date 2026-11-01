/* The fact that sent a finding of a correction turn to its flow: the spec it cites or names, the spec that evaluated what it is about, the use case its file seeds, the lead's order, or a flow the orchestrator opened for it. */
export type FindingPlacementFact = "spec" | "evaluator" | "candidate" | "lead" | "opened";

/* Where one finding of a correction turn went; empty when no flow was sent it. */
export interface FindingPlacement {
  flowId?: string;
  by?: FindingPlacementFact;
}
