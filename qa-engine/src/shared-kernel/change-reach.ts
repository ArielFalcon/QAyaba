/*
 * What a change reaches, as values: how directly, by which kind of proof, and at which entry point (a page or an operation).
 * Shared by the scope that computes the reach (change-analysis), the candidates made of it, and the parties that rank or plan
 * by them (generation, coordination). Pure.
 */

export type ReachTier = "direct" | "indirect" | "cross-repo";

/* How an entry was reached: a map link of a changed file (`implementation`, `source`, `spec`), the call graph (`graph`), a handler that serves an operation (`handler`), a frontend call site of a contract link (`call-site`) or a contract operation (`contract`). */
export type ReachBasis = "implementation" | "source" | "spec" | "graph" | "handler" | "call-site" | "contract";

export type EntryPoint =
  | { kind: "page"; repo: string; route: string }
  | { kind: "operation"; repo: string; verb: string; path: string; operationId?: string };

/* A changed symbol; the range is the store's, absent only when the index gave none. */
export interface ChangedSymbol {
  file: string;
  symbol: string;
  range?: { start: number; end: number };
}

export function entryKey(entry: EntryPoint): string {
  return entry.kind === "page" ? `page ${entry.route}` : `${entry.verb.toUpperCase()} ${entry.path}`;
}
