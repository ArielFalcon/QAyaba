/* The code-graph tools as the layers around them share them: the names the lead is offered, who may hold them, and the limits one run grants. */

/* The tools the lead is given, by the name OpenCode shows the model (the file agents/tool/codegraph.ts and its exports). */
export const CODE_GRAPH_TOOLS = ["codegraph_search_graph", "codegraph_trace_path", "codegraph_get_code_snippet"] as const;

/* The one role that holds them: the lead, which plans and reviews the change. A sidekick authors one flow from its brief and is not given them. */
export const CODE_GRAPH_AGENT = "qa-generator";

export interface CodeGraphToolLimits {
  /* Tool calls in one run, across every session of the lead. */
  maxCalls: number;
  /* The longest one call may take. */
  perCallMs: number;
  /* The most of an answer the lead is shown; the rest is cut and said to be. */
  maxAnswerChars: number;
}

export const DEFAULT_CODE_GRAPH_TOOL_LIMITS: CodeGraphToolLimits = { maxCalls: 40, perCallMs: 20_000, maxAnswerChars: 12_000 };
