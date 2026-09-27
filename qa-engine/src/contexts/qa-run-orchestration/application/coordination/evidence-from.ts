/* Map live port outputs to EvidenceRef. Never copy OpencodeRunInput; point at the canonical artifact (source + optional dataRef) with a short summary. Summaries are scrubbed here so lead context, briefs, and telemetry inherit clean text. */
import { scrub } from "./scrub.ts";
import type { EvidenceRef } from "./evidence-ref.ts";

export function evidenceFromChangeAnalysis(input: {
  action: string;
  reason: string;
  fileCount: number;
  contradiction?: boolean;
}): EvidenceRef {
  return {
    id: "change-analysis",
    kind: "change-analysis",
    source: "ChangeAnalysisPort",
    summary: scrub(`${input.action}; files=${input.fileCount}${input.contradiction ? "; contradiction" : ""}: ${input.reason}`),
    confidence: "deterministic",
    dataRef: "ChangeAnalysisPort.classify",
  };
}

export function evidenceFromGeneration(input: {
  specs: number;
  approved: boolean;
  parsed?: boolean;
}): EvidenceRef {
  return {
    id: "generation",
    kind: "generation",
    source: "GenerationPort",
    summary: scrub(`specs=${input.specs}; approved=${input.approved}; parsed=${input.parsed !== false}`),
    confidence: "observed",
    dataRef: "GenerationPort.generate",
  };
}

export function evidenceFromValidation(input: { ok: boolean; errors: number; infra?: boolean }): EvidenceRef {
  return {
    id: "validation",
    kind: "validation",
    source: "ValidationPort",
    summary: scrub(input.ok ? "ok" : `fail; errors=${input.errors}${input.infra ? "; infra" : ""}`),
    confidence: "deterministic",
    dataRef: "ValidationPort.validate",
  };
}

export function evidenceFromExecution(input: { verdict: string; failing: number }): EvidenceRef {
  return {
    id: "execution",
    kind: "execution",
    source: "ExecutionPort",
    summary: scrub(`verdict=${input.verdict}; failing=${input.failing}`),
    confidence: "deterministic",
    dataRef: "ExecutionPort.execute",
  };
}

export function evidenceFromFixLoop(input: { retries: number; adjudicator?: string }): EvidenceRef {
  return {
    id: "fix-loop",
    kind: "execution",
    source: "FixLoop",
    summary: scrub(`retries=${input.retries}${input.adjudicator ? `; adjudicator=${input.adjudicator}` : ""}`),
    confidence: "deterministic",
    dataRef: "FixLoopResult",
  };
}

export function evidenceFromCoverage(input: { status: string; ratio: number | null }): EvidenceRef {
  return {
    id: "coverage",
    kind: "coverage",
    source: "ObjectiveSignalPort",
    summary: scrub(`status=${input.status}; ratio=${input.ratio ?? "null"}`),
    confidence: "deterministic",
    dataRef: "ObjectiveSignalPort.measure",
  };
}

export function evidenceFromReview(input: { approved: boolean; blocking: number; parsed?: boolean }): EvidenceRef {
  return {
    id: "review",
    kind: "review",
    source: "ReviewPort",
    summary: scrub(`approved=${input.approved}; blocking=${input.blocking}; parsed=${input.parsed !== false}`),
    confidence: "reviewed",
    dataRef: "ReviewPort.review",
  };
}

export function evidenceFromSelectors(input: { contradictions: number }): EvidenceRef {
  return {
    id: "selector",
    kind: "selector",
    source: "selector-check",
    summary: scrub(`contradictions=${input.contradictions}`),
    confidence: "deterministic",
    dataRef: "checkSpecSelectors",
  };
}

export function evidenceFromBudget(input: { cycleCeiling: number; wallClockMs: number }): EvidenceRef {
  return {
    id: "budget",
    kind: "generation",
    source: "CoordinationBudget",
    summary: scrub(`cycleCeiling=${input.cycleCeiling}; wallClockMs=${input.wallClockMs}`),
    confidence: "deterministic",
    dataRef: "CycleBudget+WallClockBudget",
  };
}

export function evidenceFromFailureClass(errorClass: string): EvidenceRef {
  return {
    id: "failure-class",
    kind: "execution",
    source: "error-class",
    summary: scrub(errorClass),
    confidence: "deterministic",
    dataRef: "resolveErrorClass",
  };
}
