/* Map live port outputs to EvidenceRef. Never copy OpencodeRunInput; point at the canonical artifact (source + optional dataRef) with a short summary. Summaries are scrubbed here so lead context, briefs, and telemetry inherit clean text. */
import type { RedactionPort } from "@kernel/ports/redaction.port.ts";
import type { EvidenceRef } from "./evidence-ref.ts";

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

export const LESSON_EVIDENCE_PREFIX = "lesson:";

/* What an earlier run's reads of DEV taught about one page, as the brief states it: the kind that derived it, the page and the counts of its two states. */
export interface LessonFact {
  kind: string;
  scope: string;
  withResults: number;
  emptyConfirmed: number;
  latestReadAt: string;
}

/* One fact per lesson, its page in dataRef. The line states what earlier runs read and nothing about this run's DEV. */
export function evidenceFromLessons(redaction: RedactionPort, lessons: readonly LessonFact[]): EvidenceRef[] {
  return lessons.map((lesson) => ({
    id: `${LESSON_EVIDENCE_PREFIX}${lesson.kind}:${lesson.scope}`,
    kind: "lesson",
    source: lesson.kind,
    summary: redaction.redact(`DEV's data on ${lesson.scope} has not been stable: earlier runs read it with results ${lesson.withResults} time(s) and as a confirmed empty state ${lesson.emptyConfirmed} time(s); the latest read was ${lesson.latestReadAt}`),
    confidence: "deterministic",
    dataRef: lesson.scope,
  }));
}
