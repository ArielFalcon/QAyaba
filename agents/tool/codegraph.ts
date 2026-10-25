import { tool } from "@opencode-ai/plugin";
import { callCodeGraph } from "../lib/codegraph-client.mjs";

// The lead's code graph (`codegraph_explore`): one read-only action. The lead names symbols, files or short code terms and gets
// back the verbatim, line-numbered source of what matches, grouped by file, with the calls among them and what depends on them —
// answered from the index the orchestrator built for this run. Nothing runs in this process: the tool sends its terms to the
// orchestrator, which owns the index, binds the call to the run's own repo, decides how much comes back, whether the call may be
// made, and answers.
// Loaded from the global config directory only: the project configuration of a watched repo is ignored by the server. The tool
// name is the file name and the export. The logic is in ../lib/codegraph-client.mjs, which has its own test.

export const explore = tool({
  description:
    "Read the code that matters for a change in one call: name symbols, file paths or short code terms, and get the verbatim, line-numbered source of what matches, grouped by file, " +
    "with the calls among them and what depends on them (the blast radius of a changed symbol: its callers, the pages and stores that reach it). " +
    "Treat the shown source as already read; do not re-open those files with read or grep. Only a file or a name the answer lists as not shown needs another call: explore it by name. " +
    "It answers from an index of the code at this commit, not from the live site: for what the page renders (text, labels, selectors) use the live DOM.",
  args: {
    terms: tool.schema
      .array(tool.schema.string())
      .min(1)
      .max(8)
      .describe("1 to 8 names, each one symbol, file path or short code term of at most 200 characters, for example formatMoney or web/src/app/orders/orders.page.ts. No spaces, no options."),
  },
  async execute(args, context) {
    return callCodeGraph({ action: "explore", args, context, env: process.env });
  },
});
