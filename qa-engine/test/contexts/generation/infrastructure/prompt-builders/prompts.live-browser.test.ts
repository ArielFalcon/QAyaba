/* Which browser an authoring prompt sends the agent to for a page it does not show: the authenticated one when the run granted it, else the Playwright MCP. Asserted on the tool names the prompt carries, never on its wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { AGENT_BROWSER_TOOLS } from "@kernel/agent-browser.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";


function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/app/cart/cart.service.ts b/src/app/cart/cart.service.ts\n+export function total() {}\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    target: "e2e",
    mode: "diff",
    appName: "shop",
    baseUrl: "http://localhost:3000",
    intent: { type: "feat", breaking: false, message: "feat(cart): show the total", changedFiles: ["src/app/cart/cart.service.ts"] },
    ...overrides,
  };
}

const textOf = (over: Partial<OpencodeRunInput> = {}): string => buildPromptAssembled(mkInput(over), { budgetBytes: 0 }).text;
/* The Playwright MCP names its tools as the authenticated browser does, without the prefix. */
const AUTH_TOOLS = AGENT_BROWSER_TOOLS;
const PLAIN_TOOLS = AGENT_BROWSER_TOOLS.map((tool) => tool.replace(/^auth/, ""));
const mentions = (text: string, tool: string): boolean => new RegExp(`(?<![A-Za-z0-9_])${tool}(?![A-Za-z0-9_])`).test(text);

test("with the authenticated browser granted, a page the prompt does not show is read with it, never with the plain browser", () => {
  const text = textOf({ agentBrowser: { maxCalls: 20, perCallMs: 30_000, leaseWaitMs: 10_000 } });
  for (const tool of AUTH_TOOLS.slice(0, 2)) assert.ok(mentions(text, tool), tool);
  for (const tool of PLAIN_TOOLS) assert.equal(mentions(text, tool), false, tool);
});

test("without it, the prompt sends the agent to the Playwright MCP's tools", () => {
  const text = textOf();
  for (const tool of PLAIN_TOOLS.slice(0, 2)) assert.ok(mentions(text, tool), tool);
  for (const tool of AUTH_TOOLS) assert.equal(mentions(text, tool), false, tool);
});
