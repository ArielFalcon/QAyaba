import type { BlastRadius } from "../blast-radius.ts";

/**
 * The advisory block and whether it names symbols. An empty `text` is no signal, and then
 * `hasSymbols` is false: nothing is claimed.
 */
export interface StructuralSignalResult {
  text: string;
  hasSymbols: boolean;
  /** The files the block's dossier shows verbatim: a read of one re-fetches what the prompt already carries. */
  providedFiles?: string[];
  /** The commit of the code-graph index the block was read from; absent when the graph gave no answer. */
  indexedSha?: string;
}

/**
 * Advisory blast-radius markdown for GenerationEnrichment.staticSignal.
 * Absent: no staticSignal. Throw is fail-open at the caller. Unavailable
 * query degrades to an empty `text` — never a fabricated claim.
 */
export interface StructuralSignalPort {
  render(repoDir: string, changed: BlastRadius): Promise<StructuralSignalResult>;
}
