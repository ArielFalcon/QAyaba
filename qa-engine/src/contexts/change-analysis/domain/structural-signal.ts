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
