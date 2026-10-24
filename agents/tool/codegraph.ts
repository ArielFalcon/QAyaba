import { tool } from "@opencode-ai/plugin";
import { callCodeGraph } from "../lib/codegraph-client.mjs";

// The lead's code graph (`codegraph_search_graph`, `codegraph_trace_path`, `codegraph_get_code_snippet`): read-only queries of the
// structure of the app's code — what symbols exist, who calls a symbol and what it calls, a symbol's source — answered from the
// graph the orchestrator indexed for this run. Nothing runs in this process: each tool sends its arguments to the orchestrator,
// which owns the graph, binds the query to the run's own project, decides whether the call may be made, and answers.
// Loaded from the global config directory only: the project configuration of a watched repo is ignored by the server. The tool
// names are the file name and the export. The logic is in ../lib/codegraph-client.mjs, which has its own test.

const USE =
  "Use it for the structure of the change: the blast radius of a changed symbol (its callers, the pages and stores that reach it) and where a symbol lives. " +
  "It answers from an index of the code, not from the live site; for text, templates and selectors use grep and read.";

export const search_graph = tool({
  description: `Find symbols of the app's code (functions, methods, classes, components, routes) by a name pattern or by words. ${USE}`,
  args: {
    name_pattern: tool.schema.string().optional().describe("A regular expression over symbol names, for example .*RestaurantStore.*"),
    query: tool.schema.string().optional().describe("Words that describe what you look for, for example restaurant list near location."),
    label: tool.schema.string().optional().describe("Only symbols of this kind: Function, Method, Class, Interface or Route."),
    limit: tool.schema.number().int().optional().describe("How many results, at most 25 (default 10)."),
  },
  async execute(args, context) {
    return callCodeGraph({ action: "search_graph", args, context, env: process.env });
  },
});

export const trace_path = tool({
  description: `Who calls a symbol (inbound), what it calls (outbound), or both, a few hops deep. ${USE}`,
  args: {
    function_name: tool.schema.string().describe("The symbol's name, as search_graph shows it."),
    direction: tool.schema.enum(["inbound", "outbound", "both"]).optional().describe("Callers, callees or both (default both)."),
    depth: tool.schema.number().int().optional().describe("Hops to follow, at most 3 (default 2)."),
  },
  async execute(args, context) {
    return callCodeGraph({ action: "trace_path", args, context, env: process.env });
  },
});

export const get_code_snippet = tool({
  description: `The source of one symbol, by the qualified name search_graph gave for it. ${USE}`,
  args: {
    qualified_name: tool.schema.string().describe("The symbol's qualified_name from a search_graph result."),
  },
  async execute(args, context) {
    return callCodeGraph({ action: "get_code_snippet", args, context, env: process.env });
  },
});
