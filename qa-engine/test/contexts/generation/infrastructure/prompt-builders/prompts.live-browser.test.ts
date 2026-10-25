/* Which browser an authoring prompt sends the agent to for a page it does not show: the authenticated one when the run granted it, else the Playwright MCP. Asserted on the tool names the prompt carries, never on its wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import type { OpencodeRunInput } from "@contexts/generation/application/ports/generation-ports.ts";


function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/app/cart/cart.service.ts b/src/app/cart/cart.service.ts\n+export function total() {}\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "shop",
    baseUrl: "http://localhost:3000",
    intent: { type: "feat", breaking: false, message: "feat(cart): show the total", changedFiles: ["src/app/cart/cart.service.ts"] },
    ...overrides,
  };
}

const textOf = (over: Partial<OpencodeRunInput> = {}): string => buildPromptAssembled(mkInput(over), { budgetBytes: 0 }).text;
const PLAIN_BROWSER = /\bbrowser_(navigate|snapshot|console_messages|network_requests)\b/;

test("with the authenticated browser granted, a page the prompt does not show is read with it, never with the plain browser", () => {
  const text = textOf({ agentBrowser: { maxCalls: 20, perCallMs: 30_000, leaseWaitMs: 10_000 } });
  assert.match(text, /\bauthbrowser_navigate\b/);
  assert.match(text, /\bauthbrowser_snapshot\b/);
  assert.doesNotMatch(text, PLAIN_BROWSER);
});

test("without it, the prompt sends the agent to the Playwright MCP's tools", () => {
  assert.match(textOf(), /\bbrowser_navigate\b/);
});
