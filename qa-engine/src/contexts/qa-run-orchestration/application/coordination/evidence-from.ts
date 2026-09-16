// Small adapters from existing pipeline outputs to EvidenceRef. They never copy OpencodeRunInput;
// they point at the canonical artifact (source + optional dataRef) with a short summary.
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
    summary: `${input.action}; files=${input.fileCount}${input.contradiction ? "; contradiction" : ""}: ${input.reason}`,
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
    summary: `specs=${input.specs}; approved=${input.approved}; parsed=${input.parsed !== false}`,
    confidence: "observed",
    dataRef: "GenerationPort.generate",
  };
}

export function evidenceFromValidation(input: { ok: boolean; errors: number; infra?: boolean }): EvidenceRef {
  return {
    id: "validation",
    kind: "validation",
    source: "ValidationPort",
    summary: input.ok ? "ok" : `fail; errors=${input.errors}${input.infra ? "; infra" : ""}`,
    confidence: "deterministic",
    dataRef: "ValidationPort.validate",
  };
}

export function evidenceFromExecution(input: { verdict: string; failing: number }): EvidenceRef {
  return {
    id: "execution",
    kind: "execution",
    source: "ExecutionPort",
    summary: `verdict=${input.verdict}; failing=${input.failing}`,
    confidence: "deterministic",
    dataRef: "ExecutionPort.execute",
  };
}

export function evidenceFromFixLoop(input: { retries: number; adjudicator?: string }): EvidenceRef {
  return {
    id: "fix-loop",
    kind: "execution",
    source: "FixLoop",
    summary: `retries=${input.retries}${input.adjudicator ? `; adjudicator=${input.adjudicator}` : ""}`,
    confidence: "deterministic",
    dataRef: "FixLoopResult",
  };
}

export function evidenceFromCoverage(input: { status: string; ratio: number | null }): EvidenceRef {
  return {
    id: "coverage",
    kind: "coverage",
    source: "ObjectiveSignalPort",
    summary: `status=${input.status}; ratio=${input.ratio ?? "null"}`,
    confidence: "deterministic",
    dataRef: "ObjectiveSignalPort.measure",
  };
}

export function evidenceFromReview(input: { approved: boolean; blocking: number; parsed?: boolean }): EvidenceRef {
  return {
    id: "review",
    kind: "review",
    source: "ReviewPort",
    summary: `approved=${input.approved}; blocking=${input.blocking}; parsed=${input.parsed !== false}`,
    confidence: "reviewed",
    dataRef: "ReviewPort.review",
  };
}

export function evidenceFromSelectors(input: { contradictions: number }): EvidenceRef {
  return {
    id: "selector",
    kind: "selector",
    source: "selector-check",
    summary: `contradictions=${input.contradictions}`,
    confidence: "deterministic",
    dataRef: "checkSpecSelectors",
  };
}

export function evidenceFromBudget(input: { cycleCeiling: number; cycleCount: number; wallClockMs: number }): EvidenceRef {
  return {
    id: "budget",
    kind: "generation",
    source: "CoordinationBudget",
    summary: `cycle=${input.cycleCount}/${input.cycleCeiling}; wallClockMs=${input.wallClockMs}`,
    confidence: "deterministic",
    dataRef: "CycleBudget+WallClockBudget",
  };
}

export function evidenceFromFailureClass(errorClass: string): EvidenceRef {
  return {
    id: "failure-class",
    kind: "execution",
    source: "error-class",
    summary: errorClass,
    confidence: "deterministic",
    dataRef: "resolveErrorClass",
  };
}
