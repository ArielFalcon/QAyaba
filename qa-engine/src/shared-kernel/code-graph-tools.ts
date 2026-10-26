/* The code-graph tools as the layers around them share them: the names the lead is offered, who may hold them, and the limits one run grants. */

/* The tools the lead is given, by the name OpenCode shows the model (the file agents/tool/codegraph.ts and its exports). */
export const CODE_GRAPH_TOOLS = ["codegraph_explore"] as const;

/* The lead, which plans and reviews the change, and the explore role, which answers the lead's questions about the code and the live app read-only. An author sidekick writes one flow from its brief and is not given the tools. */
export const CODE_GRAPH_LEAD_AGENT = "qa-lead";
export const CODE_GRAPH_EXPLORE_AGENT = "qa-explore";
export const CODE_GRAPH_AGENTS: ReadonlySet<string> = new Set([CODE_GRAPH_LEAD_AGENT, CODE_GRAPH_EXPLORE_AGENT]);

export interface CodeGraphToolLimits {
  /* Tool calls in one run, across every session of the lead. */
  maxCalls: number;
  /* The most files one call's answer may show; the orchestrator decides it, never the caller. */
  maxFiles: number;
  /* The most of an answer the lead is shown; the files that do not fit are left out whole and said to be. */
  maxAnswerChars: number;
}

export const DEFAULT_CODE_GRAPH_TOOL_LIMITS: CodeGraphToolLimits = { maxCalls: 40, maxFiles: 8, maxAnswerChars: 12_000 };
