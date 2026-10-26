/*
 * A-2b: the violations the intent lock found are facts of the next correction turn. The generator sees
 * which rule fired, on which clause, with what the contract held before and after — and nothing else:
 * the section hands it evidence, not an order, and it is bounded and sanitized like every other
 * agent-adjacent text that becomes prompt text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { lintCell, type LintSection } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { AssembledPrompt } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import { setAgentsConfigPath } from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog";
import { rosterFixturePath } from "../../../../support/roster-fixture.ts";

/* The roster is an input here: window budgets resolve from the roster fixture, never the deployable agents/opencode.json. */
setAgentsConfigPath(rosterFixturePath());

function mkInput(over: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/cart.ts b/src/cart.ts\n+export const discount = 0.1;\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    target: "e2e",
    mode: "diff",
    appName: "shop",
    baseUrl: "http://localhost:3000",
    ...over,
  };
}

const VIOLATION = {
  rule: "weakened-matcher",
  file: "flows/checkout.spec.ts",
  clauseId: "assertion-1",
  before: "strength=exact",
  after: "strength=presence",
};

const SECRET = `ghp_${"A".repeat(36)}`;

test("a correction turn carries the contract violations as facts: the rule, the clause and what changed", () => {
  const { text } = buildPromptAssembled(mkInput({ reviewCorrections: ["[wrong-objective] assert the discount"], contractFeedback: [VIOLATION] }));
  assert.match(text, /Contract violations/);
  assert.match(text, /weakened-matcher/);
  assert.match(text, /flows\/checkout\.spec\.ts#assertion-1/);
  assert.match(text, /strength=exact/);
  assert.match(text, /strength=presence/);
});

test("a turn without contract feedback carries no section", () => {
  const { text } = buildPromptAssembled(mkInput({ reviewCorrections: ["[wrong-objective] assert the discount"] }));
  assert.doesNotMatch(text, /Contract violations/);
});

test("the violations are capped, and the cap says how many it left out", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ ...VIOLATION, clauseId: `assertion-${i}` }));
  const { text } = buildPromptAssembled(mkInput({ reviewCorrections: ["[wrong-objective] assert the discount"], contractFeedback: many }));
  assert.match(text, /assertion-0/);
  assert.doesNotMatch(text, /assertion-8/);
  assert.match(text, /3 more/);
});

/* The section's own words, cut from the assembled text by the sizes the assembler reports. */
function sectionText(a: AssembledPrompt, id: string): string {
  const bytes = Buffer.from(a.text, "utf8");
  let offset = 0;
  for (const [sectionId, size] of Object.entries(a.sectionSizes)) {
    if (sectionId === id) return bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
  }
  return "";
}

test("a secret inside a violation never reaches the prompt, and the section is facts only", () => {
  const assembled = buildPromptAssembled(
    mkInput({
      reviewCorrections: ["[wrong-objective] assert the discount"],
      contractFeedback: [{ ...VIOLATION, after: `expected=${SECRET}` }],
    }),
  );
  assert.ok(!assembled.text.includes(SECRET), "a credential in a literal is redacted before the prompt");
  const sections: LintSection[] = Object.keys(assembled.sectionSizes).map((id) => ({
    id,
    layer: "assembled" as const,
    text: sectionText(assembled, id),
    claims: assembled.claims[id] ?? [],
    ...(id === "contract-feedback" ? { factsOnly: true } : {}),
  }));
  assert.deepEqual(lintCell({ name: "corrections-with-contract", regen: true, sections }).filter((finding) => finding.rule === "R6" || finding.rule === "R15"), []);
});
