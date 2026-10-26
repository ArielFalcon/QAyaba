/* A lower-confidence claim cannot invalidate a higher-confidence one without new evidence of equal or greater rank. */
import type { EvidenceConfidence, EvidenceRef } from "./evidence-ref.ts";
import { EMPTY_READ_EVIDENCE_PREFIX, PACK_DATA_EVIDENCE_PREFIX } from "./evidence-from.ts";

const RANK: Record<EvidenceConfidence, number> = {
  deterministic: 3,
  reviewed: 2,
  observed: 1,
  inferred: 0,
};

export function confidenceRank(confidence: EvidenceConfidence): number {
  return RANK[confidence];
}

export function preferredEvidence(a: EvidenceRef, b: EvidenceRef): EvidenceRef {
  return RANK[a.confidence] >= RANK[b.confidence] ? a : b;
}

/* Deterministic pipeline facts win over agent observations when they disagree on success. */
export function agentClaimInvalidatedBy(evidence: readonly EvidenceRef[]): EvidenceRef | undefined {
  const agentSuccess = evidence.find(
    (e) =>
      (e.kind === "agent-observation" || e.confidence === "inferred") &&
      /\b(completed|success|approved=true)\b/i.test(e.summary),
  );
  if (!agentSuccess) return undefined;
  return evidence.find(
    (e) =>
      e.confidence === "deterministic" &&
      (e.kind === "validation" || e.kind === "execution" || e.kind === "selector") &&
      /\b(fail|invalid|contradiction|errors=[1-9]|failing=[1-9])\b/i.test(e.summary),
  );
}

/* Two reads of the same page disagree: the Context Pack read it with results, a flow's run_spec call read it empty. The empty read is then no evidence that the page has no data. */
export function observationConflictIn(evidence: readonly EvidenceRef[]): { pack: EvidenceRef; read: EvidenceRef } | undefined {
  for (const read of evidence) {
    if (!read.id.startsWith(EMPTY_READ_EVIDENCE_PREFIX) || read.dataRef === undefined) continue;
    const pack = evidence.find((e) => e.id.startsWith(PACK_DATA_EVIDENCE_PREFIX) && e.confidence === "deterministic" && e.dataRef === read.dataRef);
    if (pack) return { pack, read };
  }
  return undefined;
}
