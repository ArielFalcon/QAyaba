import { tool } from "@opencode-ai/plugin";
import { callRunSpec } from "../lib/run-spec-client.mjs";

// `run_spec`: the generator executes a spec it wrote, once, against DEV, as the suite would run it. The orchestrator runs it
// (in its sandbox, under a namespace of its own, within the caps the task states) and answers; nothing runs in this process.
// Loaded from the global config directory only: the project configuration of a watched repo is ignored by the server.
// The logic is in ../lib/run-spec-client.mjs, which has its own test.

export default tool({
  description:
    "Run one Playwright spec file you wrote, once, against DEV, as the suite will run it, and get each test's result: its error, the page it ended on and that page's accessibility tree. " +
    "Use it only when your task states a run_spec budget. The answer carries the calls, time and DEV writes still left.",
  args: {
    path: tool.schema.string().describe("The spec file, relative to the repository (e2e/flows/x.spec.ts) or to e2e/. A throwaway under e2e/.qa-probe/ is allowed and is never delivered."),
    grep: tool.schema.string().optional().describe("A fragment of one test's title, to run only that test. Matched literally."),
  },
  async execute(args, context) {
    return callRunSpec({ args, context, env: process.env });
  },
});
