/*
 * A-2b: the violations the intent lock found are facts of the next correction turn. The generator sees
 * which rule fired, on which clause, with what the contract held before and after — and nothing else:
 * the section hands it evidence, not an order, and it is bounded and sanitized like every other
 * agent-adjacent text that becomes prompt text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { CONTRACT_FEEDBACK_MAX, CONTRACT_FEEDBACK_SECTION_ID } from "@contexts/generation/infrastructure/prompt-builders/generator-renderers.ts";
import { lintCell, type LintSection } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { AssembledPrompt } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";

/* The roster is an input here: window budgets resolve from the roster fixture, never the deployable agents/opencode.json. */

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

const CORRECTIONS = ["[wrong-objective] assert the discount"];

test("a correction turn carries the contract violations as facts: the rule, the clause and what changed", () => {
  const assembled = buildPromptAssembled(mkInput({ reviewCorrections: CORRECTIONS, contractFeedback: [VIOLATION] }));
  assert.notEqual(assembled.sectionSizes[CONTRACT_FEEDBACK_SECTION_ID], undefined);
  const text = sectionText(assembled, CONTRACT_FEEDBACK_SECTION_ID);
  for (const datum of [VIOLATION.rule, VIOLATION.file, VIOLATION.clauseId, VIOLATION.before, VIOLATION.after]) assert.ok(text.includes(datum), datum);
});

test("a turn without contract feedback carries no section", () => {
  const assembled = buildPromptAssembled(mkInput({ reviewCorrections: CORRECTIONS }));
  assert.equal(assembled.sectionSizes[CONTRACT_FEEDBACK_SECTION_ID], undefined);
});

test("the violations are capped, and the cap says how many it left out", () => {
  const total = 20;
  const many = Array.from({ length: total }, (_, i) => ({ ...VIOLATION, clauseId: `assertion-${i}` }));
  const text = sectionText(buildPromptAssembled(mkInput({ reviewCorrections: CORRECTIONS, contractFeedback: many })), CONTRACT_FEEDBACK_SECTION_ID);
  const shown = many.filter((violation) => text.includes(violation.clauseId));
  assert.equal(shown.length, CONTRACT_FEEDBACK_MAX, "the first violations up to the cap are listed and the rest are left out");
  assert.deepEqual(shown, many.slice(0, shown.length), "the listed ones are the first ones, in order");
  assert.ok(text.includes(String(total - shown.length)), "the count of the omitted violations is stated (more than any listed index, so a clause id cannot stand for it)");
});

test("a secret inside a violation never reaches the prompt, and the section is facts only", () => {
  const assembled = buildPromptAssembled(
    mkInput({
      reviewCorrections: CORRECTIONS,
      contractFeedback: [{ ...VIOLATION, after: `expected=${SECRET}` }],
    }),
  );
  assert.ok(!assembled.text.includes(SECRET), "a credential in a literal is redacted before the prompt");
  const sections: LintSection[] = Object.keys(assembled.sectionSizes).map((id) => ({
    id,
    layer: "assembled" as const,
    text: sectionText(assembled, id),
    claims: assembled.claims[id] ?? [],
    ...(id === CONTRACT_FEEDBACK_SECTION_ID ? { factsOnly: true } : {}),
  }));
  assert.deepEqual(lintCell({ name: "corrections-with-contract", regen: true, sections }).filter((finding) => finding.rule === "R6" || finding.rule === "R15"), []);
});
