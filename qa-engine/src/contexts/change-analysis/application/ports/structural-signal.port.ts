import type { BlastRadius } from "@kernel/blast-radius.ts";
import type { StructuralSignalResult } from "../../domain/structural-signal.ts";

/**
 * Advisory blast-radius markdown for GenerationEnrichment.staticSignal.
 * Absent: no staticSignal. Throw is fail-open at the caller. Unavailable
 * query degrades to an empty `text` — never a fabricated claim.
 */
export interface StructuralSignalPort {
  render(repoDir: string, changed: BlastRadius): Promise<StructuralSignalResult>;
}
