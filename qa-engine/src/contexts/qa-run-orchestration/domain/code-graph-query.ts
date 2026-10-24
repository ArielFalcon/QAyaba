/*
 * What a code-graph call the lead makes may ask. Three read-only queries of the run's own project are served: a search for
 * symbols, the callers or callees of one, and the source of one. Nothing else the graph's CLI offers is: not a free graph
 * query, not indexing, not deleting, not a decision record. The project is never the caller's to name: the orchestrator binds
 * it to the run (the graph holds every app's code). Arguments are read by their known keys, checked and bounded; an argument out
 * of its bounds is refused rather than cut, except a limit or a depth, which is held to its ceiling.
 * Pure: no clock, no file, no process.
 */

export const CODE_GRAPH_ACTION = {
  SEARCH: "search_graph",
  TRACE: "trace_path",
  SNIPPET: "get_code_snippet",
} as const;

const MAX_PATTERN_CHARS = 200;
const MAX_QUALIFIED_NAME_CHARS = 400;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 3;
const LABEL = /^[A-Za-z]{1,40}$/;
const DIRECTIONS = new Set(["inbound", "outbound", "both"]);

export type CodeGraphQuery =
  | { action: typeof CODE_GRAPH_ACTION.SEARCH; namePattern?: string; query?: string; label?: string; limit: number }
  | { action: typeof CODE_GRAPH_ACTION.TRACE; functionName: string; direction: "inbound" | "outbound" | "both"; depth: number }
  | { action: typeof CODE_GRAPH_ACTION.SNIPPET; qualifiedName: string };

function text(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > max ? null : trimmed;
}

function bounded(value: unknown, fallback: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  return Math.min(value, max);
}

/* The query the call's body names, or undefined when it is not one the lead may make. */
export function admitCodeGraphQuery(raw: Record<string, unknown>): CodeGraphQuery | undefined {
  switch (raw.action) {
    case CODE_GRAPH_ACTION.SEARCH: {
      const namePattern = text(raw.name_pattern, MAX_PATTERN_CHARS);
      const query = text(raw.query, MAX_PATTERN_CHARS);
      const label = text(raw.label, 40);
      const limit = bounded(raw.limit, DEFAULT_LIMIT, MAX_LIMIT);
      if (namePattern === null || query === null || label === null || limit === null) return undefined;
      if (namePattern === undefined && query === undefined) return undefined;
      if (label !== undefined && !LABEL.test(label)) return undefined;
      return { action: CODE_GRAPH_ACTION.SEARCH, ...(namePattern !== undefined ? { namePattern } : {}), ...(query !== undefined ? { query } : {}), ...(label !== undefined ? { label } : {}), limit };
    }
    case CODE_GRAPH_ACTION.TRACE: {
      const functionName = text(raw.function_name, MAX_PATTERN_CHARS);
      const direction = raw.direction === undefined ? "both" : raw.direction;
      const depth = bounded(raw.depth, DEFAULT_DEPTH, MAX_DEPTH);
      if (typeof functionName !== "string" || depth === null || typeof direction !== "string" || !DIRECTIONS.has(direction)) return undefined;
      return { action: CODE_GRAPH_ACTION.TRACE, functionName, direction: direction as "inbound" | "outbound" | "both", depth };
    }
    case CODE_GRAPH_ACTION.SNIPPET: {
      const qualifiedName = text(raw.qualified_name, MAX_QUALIFIED_NAME_CHARS);
      return typeof qualifiedName === "string" ? { action: CODE_GRAPH_ACTION.SNIPPET, qualifiedName } : undefined;
    }
    default:
      return undefined;
  }
}

/* The graph CLI's tool and its JSON argument for an admitted query, on the run's project. */
export function cliCallOf(query: CodeGraphQuery, project: string): { tool: string; json: string } {
  switch (query.action) {
    case CODE_GRAPH_ACTION.SEARCH:
      return {
        tool: query.action,
        json: JSON.stringify({
          project,
          ...(query.namePattern !== undefined ? { name_pattern: query.namePattern } : {}),
          ...(query.query !== undefined ? { query: query.query } : {}),
          ...(query.label !== undefined ? { label: query.label } : {}),
          limit: query.limit,
        }),
      };
    case CODE_GRAPH_ACTION.TRACE:
      return { tool: query.action, json: JSON.stringify({ project, function_name: query.functionName, direction: query.direction, depth: query.depth }) };
    case CODE_GRAPH_ACTION.SNIPPET:
      return { tool: query.action, json: JSON.stringify({ project, qualified_name: query.qualifiedName }) };
  }
}

/* One call of the lead's code-graph tools, as the tools endpoint hands it on: the session and agent the tool reported, and the admitted query. */
export interface CodeGraphToolRequest {
  sessionId: string;
  agent: string;
  messageId?: string;
  query: CodeGraphQuery;
}

export type CodeGraphRefusalCode = "wrong-agent" | "revoked" | "no-calls" | "failed";

export type CodeGraphToolResponse =
  | { ok: true; result: string; truncated: boolean; callsLeft: number }
  | { ok: false; code: CodeGraphRefusalCode; message: string };
