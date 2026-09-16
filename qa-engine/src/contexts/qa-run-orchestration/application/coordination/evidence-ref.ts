// Opaque handle to a pipeline fact. Adapters that fill `kind` from live ports land in Fase 2;
// the shape is specified there and is included here so CoordinationDecision.evidence can exist
// without duplicating OpencodeRunInput.
export type EvidenceKind =
  | "change-analysis"
  | "generation"
  | "validation"
  | "execution"
  | "selector"
  | "coverage"
  | "mutation"
  | "review"
  | "agent-observation";

export type EvidenceConfidence = "deterministic" | "observed" | "reviewed" | "inferred";

export interface EvidenceRef {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly source: string;
  readonly summary: string;
  readonly confidence: EvidenceConfidence;
  readonly dataRef?: string;
}
