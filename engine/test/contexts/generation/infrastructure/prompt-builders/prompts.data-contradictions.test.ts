/* The data contradictions the run recorded, as the reviewer receives them: a section of their own, one line per fact with the page and the key a citation names, present only when the run recorded some. Asserted on section ids and the facts' own data, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewerPromptAssembled, type AssembledPrompt } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { ReviewInput } from "@contexts/generation/domain/generation-input.ts";
import { dataContradictionRef, type DataContradiction } from "@kernel/data-contradiction.ts";
import { contradictionFact } from "../../../../support/data-contradiction.ts";

function mkReview(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    diff: "diff --git a/src/browse.ts b/src/browse.ts\n+export const filter = 1;\n",
    specs: ["browse.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "shop",
    mode: "diff",
    ...overrides,
  };
}

function sectionText(a: AssembledPrompt, id: string): string {
  const bytes = Buffer.from(a.text, "utf8");
  let offset = 0;
  for (const [sectionId, size] of Object.entries(a.sectionSizes)) {
    if (sectionId === id) return bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
  }
  return "";
}

const SECTION = "reviewer-data-contradictions";
const FACTS: DataContradiction[] = [
  contradictionFact({ provider: "provider-declared-absent" }),
  contradictionFact({ route: "/shops/es", template: "/shops/:region", key: "zone", operation: "GET https://app.example/api/shops/by-region/ES", items: 3, alsoCarriedBy: ["GET https://app.example/api/shops"] }),
];

test("the reviewer receives the data contradictions in a section of their own, each with the ref that cites it, and the citation that names one", () => {
  const text = sectionText(buildReviewerPromptAssembled(mkReview({ dataContradictions: FACTS })), SECTION);
  for (const fact of FACTS) {
    assert.ok(text.includes(dataContradictionRef(fact)), dataContradictionRef(fact));
    assert.ok(text.includes(fact.operation) && text.includes(fact.alsoCarriedBy![0]!), fact.key);
  }
  assert.ok(text.includes('"kind":"contradiction"'), "it says how a contradiction is cited");
});

test("without a recorded contradiction the reviewer prompt has no such section", () => {
  assert.equal(SECTION in buildReviewerPromptAssembled(mkReview()).sectionSizes, false);
  assert.equal(SECTION in buildReviewerPromptAssembled(mkReview({ dataContradictions: [] })).sectionSizes, false);
});

test("a secret in an operation's address is taken out of the reviewer's section", () => {
  const token = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const leaky: DataContradiction = { ...FACTS[0]!, operation: `GET https://app.example/api/${token}/items` };
  const a = buildReviewerPromptAssembled(mkReview({ dataContradictions: [leaky] }));
  assert.equal(sectionText(a, SECTION).includes(token), false);
});
