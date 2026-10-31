/* Opaque handle to a pipeline fact: a reference to evidence the run holds, without duplicating OpencodeRunInput. */
export type EvidenceKind =
  | "change-analysis"
  | "generation"
  | "validation"
  | "execution"
  | "selector"
  | "coverage"
  | "mutation"
  | "review"
  | "grounding"
  | "agent-observation"
  | "lesson";

export type EvidenceConfidence = "deterministic" | "observed" | "reviewed" | "inferred";

export interface EvidenceRef {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly source: string;
  readonly summary: string;
  readonly confidence: EvidenceConfidence;
  readonly dataRef?: string;
}
