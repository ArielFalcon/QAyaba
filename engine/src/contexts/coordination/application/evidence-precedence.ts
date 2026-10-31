/* How the facts a lead holds about one page relate: a read with results and a read that found none. */
import type { EvidenceRef } from "./evidence-ref.ts";
import { EMPTY_READ_EVIDENCE_PREFIX, PACK_DATA_EVIDENCE_PREFIX } from "./evidence-from.ts";

/* Two reads of the same page disagree: the Context Pack read it with results, a flow's run_spec call read it empty. The empty read is then no evidence that the page has no data. */
export function observationConflictIn(evidence: readonly EvidenceRef[]): { pack: EvidenceRef; read: EvidenceRef } | undefined {
  for (const read of evidence) {
    if (!read.id.startsWith(EMPTY_READ_EVIDENCE_PREFIX) || read.dataRef === undefined) continue;
    const pack = evidence.find((e) => e.id.startsWith(PACK_DATA_EVIDENCE_PREFIX) && e.confidence === "deterministic" && e.dataRef === read.dataRef);
    if (pack) return { pack, read };
  }
  return undefined;
}
