/* Map live port outputs to EvidenceRef. Never copy OpencodeRunInput; point at the canonical artifact (source + optional dataRef) with a short summary. Summaries are scrubbed here so lead context, briefs, and telemetry inherit clean text. */
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import type { EvidenceRef } from "./evidence-ref.ts";

export function evidenceFromChangeAnalysis(redaction: RedactionPort, input: {
  action: string;
  reason: string;
  fileCount: number;
  contradiction?: boolean;
}): EvidenceRef {
  return {
    id: "change-analysis",
    kind: "change-analysis",
    source: "ChangeAnalysisPort",
    summary: redaction.redact(`${input.action}; files=${input.fileCount}${input.contradiction ? "; contradiction" : ""}: ${input.reason}`),
    confidence: "deterministic",
    dataRef: "ChangeAnalysisPort.classify",
  };
}

export function evidenceFromGeneration(redaction: RedactionPort, input: {
  specs: number;
  approved: boolean;
  parsed?: boolean;
}): EvidenceRef {
  return {
    id: "generation",
    kind: "generation",
    source: "GenerationPort",
    summary: redaction.redact(`specs=${input.specs}; approved=${input.approved}; parsed=${input.parsed !== false}`),
    confidence: "observed",
    dataRef: "GenerationPort.generate",
  };
}

export function evidenceFromValidation(redaction: RedactionPort, input: { ok: boolean; errors: number; infra?: boolean }): EvidenceRef {
  return {
    id: "validation",
    kind: "validation",
    source: "ValidationPort",
    summary: redaction.redact(input.ok ? "ok" : `fail; errors=${input.errors}${input.infra ? "; infra" : ""}`),
    confidence: "deterministic",
    dataRef: "ValidationPort.validate",
  };
}

export function evidenceFromExecution(redaction: RedactionPort, input: { verdict: string; failing: number }): EvidenceRef {
  return {
    id: "execution",
    kind: "execution",
    source: "ExecutionPort",
    summary: redaction.redact(`verdict=${input.verdict}; failing=${input.failing}`),
    confidence: "deterministic",
    dataRef: "ExecutionPort.execute",
  };
}

export function evidenceFromFixLoop(redaction: RedactionPort, input: { retries: number; adjudicator?: string }): EvidenceRef {
  return {
    id: "fix-loop",
    kind: "execution",
    source: "FixLoop",
    summary: redaction.redact(`retries=${input.retries}${input.adjudicator ? `; adjudicator=${input.adjudicator}` : ""}`),
    confidence: "deterministic",
    dataRef: "FixLoopResult",
  };
}

export function evidenceFromCoverage(redaction: RedactionPort, input: { status: string; ratio: number | null }): EvidenceRef {
  return {
    id: "coverage",
    kind: "coverage",
    source: "ObjectiveSignalPort",
    summary: redaction.redact(`status=${input.status}; ratio=${input.ratio ?? "null"}`),
    confidence: "deterministic",
    dataRef: "ObjectiveSignalPort.measure",
  };
}

export function evidenceFromReview(redaction: RedactionPort, input: { approved: boolean; blocking: number; parsed?: boolean }): EvidenceRef {
  return {
    id: "review",
    kind: "review",
    source: "ReviewPort",
    summary: redaction.redact(`approved=${input.approved}; blocking=${input.blocking}; parsed=${input.parsed !== false}`),
    confidence: "reviewed",
    dataRef: "ReviewPort.review",
  };
}

export function evidenceFromSelectors(redaction: RedactionPort, input: { contradictions: number }): EvidenceRef {
  return {
    id: "selector",
    kind: "selector",
    source: "selector-check",
    summary: redaction.redact(`contradictions=${input.contradictions}`),
    confidence: "deterministic",
    dataRef: "checkSpecSelectors",
  };
}

export function evidenceFromBudget(redaction: RedactionPort, input: { cycleCeiling: number; wallClockMs: number }): EvidenceRef {
  return {
    id: "budget",
    kind: "generation",
    source: "CoordinationBudget",
    summary: redaction.redact(`cycleCeiling=${input.cycleCeiling}; wallClockMs=${input.wallClockMs}`),
    confidence: "deterministic",
    dataRef: "CycleBudget+WallClockBudget",
  };
}

export function evidenceFromFailureClass(redaction: RedactionPort, errorClass: string): EvidenceRef {
  return {
    id: "failure-class",
    kind: "execution",
    source: "error-class",
    summary: redaction.redact(errorClass),
    confidence: "deterministic",
    dataRef: "resolveErrorClass",
  };
}

export const PACK_DATA_EVIDENCE_PREFIX = "pack-data:";
export const EMPTY_READ_EVIDENCE_PREFIX = "empty-read:";

/* The pages the run's Context Pack read with results under the app's declared data state: one fact per page, its pathname in dataRef. */
export function evidenceFromPackDataRoutes(redaction: RedactionPort, routes: readonly { path: string; resultCount: number }[]): EvidenceRef[] {
  return routes.map((route) => ({
    id: `${PACK_DATA_EVIDENCE_PREFIX}${route.path}`,
    kind: "grounding",
    source: "ContextPack",
    summary: redaction.redact(`the Context Pack read ${route.resultCount} results on ${route.path} under the app's declared data state`),
    confidence: "deterministic",
    dataRef: route.path,
  }));
}

/* A run_spec call the orchestrator ran for a flow ended a failing test on this page with no results read: its pathname in dataRef. */
export function evidenceFromEmptyRead(redaction: RedactionPort, path: string): EvidenceRef {
  return {
    id: `${EMPTY_READ_EVIDENCE_PREFIX}${path}`,
    kind: "execution",
    source: "run_spec",
    summary: redaction.redact(`a run_spec call of this flow read no results on ${path} at its failure point`),
    confidence: "observed",
    dataRef: path,
  };
}
