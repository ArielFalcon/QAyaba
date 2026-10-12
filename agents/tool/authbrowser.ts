import { tool } from "@opencode-ai/plugin";
import { callAuthBrowser } from "../lib/authbrowser-client.mjs";

// The authenticated browser (`authbrowser_navigate`, `authbrowser_snapshot`, `authbrowser_click`, `authbrowser_type`): the authoring
// roles read the app through the session the run signed in with, which the orchestrator holds. Nothing runs in this process: each
// tool sends its arguments to the orchestrator, which owns the browser, decides whether the call may be made, and answers.
// Loaded from the global config directory only: the project configuration of a watched repo is ignored by the server. The tool
// names are the file name and the export (`authbrowser_navigate`, ...). The logic is in ../lib/authbrowser-client.mjs, which has
// its own test.

const READ_ONLY =
  "This browser is signed in to the app as the test account and reads it: a request that would write to DEV (a form submit, a delete, an API write) is blocked and listed in the answer, and so are the routes the app closes to you. " +
  "Use it only when your task states an authenticated browser budget; it is the way to see what a signed-in page looks like while you author, and it is not the browser your specs run in.";

export const navigate = tool({
  description: `Open a page of the app in the signed-in browser and get its title and accessibility tree, with a [ref=...] for each element you can act on. ${READ_ONLY}`,
  args: {
    url: tool.schema.string().describe("A path of the app (/orders) or an address on one of its origins. A page the app closes to you, or another host, is refused."),
  },
  async execute(args, context) {
    return callAuthBrowser({ action: "navigate", args, context, env: process.env });
  },
});

export const snapshot = tool({
  description: `Read the current page of the signed-in browser again: its address, title and accessibility tree with fresh [ref=...] values. Take one after anything that changes the page, since refs belong to the snapshot they came from. ${READ_ONLY}`,
  args: {},
  async execute(args, context) {
    return callAuthBrowser({ action: "snapshot", args, context, env: process.env });
  },
});

export const click = tool({
  description: `Click the element a snapshot gave a ref for, in the signed-in browser, and get the page as it is after. A click that would write to DEV is blocked, not sent. ${READ_ONLY}`,
  args: {
    ref: tool.schema.string().describe("A ref from the latest snapshot, for example e5."),
  },
  async execute(args, context) {
    return callAuthBrowser({ action: "click", args, context, env: process.env });
  },
});

export const type = tool({
  description: `Type into the field a snapshot gave a ref for, in the signed-in browser (a search box, a filter), and optionally press Enter. It never types into a password field. ${READ_ONLY}`,
  args: {
    ref: tool.schema.string().describe("A ref from the latest snapshot, for example e2."),
    text: tool.schema.string().describe("The text to put in the field, replacing what it holds."),
    submit: tool.schema.boolean().optional().describe("Press Enter after typing. A form that submits a write is blocked."),
  },
  async execute(args, context) {
    return callAuthBrowser({ action: "type", args, context, env: process.env });
  },
});
