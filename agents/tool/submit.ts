import { readFileSync } from "node:fs";
import { tool } from "@opencode-ai/plugin";
import { callSubmit } from "../lib/submit-client.mjs";
import { argsShapeOf } from "../lib/submit-schema.mjs";

// The submit tools: how a role delivers the answer of a turn. Each tool's arguments are the contract the orchestrator checks the
// answer against (agents/lib/submit-contracts.json, rendered from the wire schemas of the contexts by `npm run submit-contracts:gen`).
// Nothing is judged, written or run in this process: the tool sends the arguments to the orchestrator, which holds the contract of
// the turn the session is in, answers `accepted` or the errors to correct, and refuses a call from any role or turn it did not arm.
// Loaded from the global config directory only: the project configuration of a watched repo is ignored by the server. The tool
// name is the file name and the export. The logic is in ../lib/submit-client.mjs and ../lib/submit-schema.mjs, which have their own tests.

const CONTRACTS = JSON.parse(readFileSync(new URL("../lib/submit-contracts.json", import.meta.url), "utf8"));

const CHECKED =
  " The orchestrator checks the arguments and answers: if it lists errors, fix every one and call this tool again with the whole answer. The turn is over once it says accepted.";

function submit(name: string, description: string) {
  return tool({
    description: description + CHECKED,
    args: argsShapeOf(tool.schema, CONTRACTS[name]),
    async execute(args, context) {
      return callSubmit({ tool: name, answer: args, context, env: process.env });
    },
  });
}

export const plan = submit("submit_plan", "Deliver your plan for this change: the flows to author, or a noop with the reason nothing here is worth a test.");
export const flow_review = submit("submit_flow_review", "Deliver your decision on each flow your sidekicks authored: accept, revise, replace or drop.");
export const corrections = submit("submit_corrections", "Deliver how each verified finding is routed: to the flow it belongs to, or rebutted.");
export const result = submit("submit_result", "Deliver the result of the flow you authored: its status, what you changed and what you could not meet.");
export const specs = submit("submit_specs", "Deliver the specs you wrote or changed, or the decision that none is worth a test.");
export const review = submit("submit_review", "Deliver your verdict on the specs under review: approved or not, with the corrections that justify it.");
export const profiles = submit("submit_profiles", "Deliver the boundary profiles you hypothesize for this app.");
