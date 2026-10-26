/*
 * What a code-graph call the lead makes may ask. One read-only query of the run's own index is served: `explore`, a bag of
 * names (symbols, files, short code terms) answered with the verbatim source of what matches and the calls among them. Nothing
 * else is: not a free graph query, not indexing, not deleting. The repo and its workspace are never the caller's to name (the
 * orchestrator binds them to the run), and neither is how much comes back: the file count and the size of the answer are the
 * orchestrator's, per call. Terms are read by their known key and checked; one that is out of bounds refuses the call rather
 * than being cut or fixed. A term is a single identifier or path, so it can never be read as an option of the engine.
 * Pure: no clock, no file, no process.
 */

export const CODE_GRAPH_ACTION = {
  EXPLORE: "explore",
} as const;

export const MAX_EXPLORE_TERMS = 8;
export const MAX_TERM_CHARS = 200;
/* Identifier and path characters (word characters, `$`, `.`, `/`, `:`, `@`, `#`, `~`, `-`); no space, quote, shell or glob character. */
const TERM = /^[A-Za-z0-9_$.\/:@#~-]+$/;

/* A single identifier or path the engine reads as a name, never as an option. */
export function isExploreTerm(term: string): boolean {
  return term.length > 0 && term.length <= MAX_TERM_CHARS && !term.startsWith("-") && TERM.test(term);
}

export interface CodeGraphQuery {
  action: typeof CODE_GRAPH_ACTION.EXPLORE;
  terms: string[];
}

function termsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EXPLORE_TERMS) return undefined;
  const terms: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isExploreTerm(item)) return undefined;
    terms.push(item);
  }
  return terms;
}

/* The query the call's body names, or undefined when it is not one the lead may make. */
export function admitCodeGraphQuery(raw: Record<string, unknown>): CodeGraphQuery | undefined {
  if (raw.action !== CODE_GRAPH_ACTION.EXPLORE) return undefined;
  const terms = termsOf(raw.terms);
  return terms === undefined ? undefined : { action: CODE_GRAPH_ACTION.EXPLORE, terms };
}

/* One call of the lead's code-graph tool, as the tools endpoint hands it on: the session and agent the tool reported, and the admitted query. */
export interface CodeGraphToolRequest {
  sessionId: string;
  agent: string;
  messageId?: string;
  query: CodeGraphQuery;
}

export type CodeGraphRefusalCode = "wrong-agent" | "revoked" | "no-calls" | "failed";

export type CodeGraphToolResponse =
  | { ok: true; result: string; truncated: boolean; /* The commit of the index the answer was read from. */ indexedSha: string; callsLeft: number }
  | { ok: false; code: CodeGraphRefusalCode; message: string };
