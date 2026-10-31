/* The passing cases the run recorded as checking a page only as DEV served it confirmed empty, as the reviewer receives them: a section of their own, one line per case with the ref a citation names and its pages, present only when the run recorded some. Asserted on section ids and the facts' own data, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewerPromptAssembled, type AssembledPrompt } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { ReviewInput } from "@contexts/generation/domain/generation-input.ts";
import { ambientPinRef, type AmbientDataPin } from "@kernel/page-data-read.ts";

function mkReview(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    diff: "diff --git a/src/listing.ts b/src/listing.ts\n+export const empty = 1;\n",
    specs: ["flows/listing.spec.ts"],
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

const SECTION = "reviewer-ambient-data-pins";
const PINS: AmbientDataPin[] = [
  { file: "flows/listing.spec.ts", test: "listing › renders the empty listing", pages: ["/listing"] },
  { file: "flows/cart.spec.ts", test: "shows no items", pages: ["/cart", "/cart/saved"] },
];

test("the reviewer receives the ambient pins in a section of their own, each with the ref that cites it and its pages, and the citation that names one", () => {
  const text = sectionText(buildReviewerPromptAssembled(mkReview({ ambientDataPins: PINS })), SECTION);
  for (const pin of PINS) {
    assert.ok(text.includes(ambientPinRef(pin)), ambientPinRef(pin));
    for (const page of pin.pages) assert.ok(text.includes(page), page);
  }
  assert.ok(text.includes('"kind":"ambient"'), "it says how a pinned case is cited");
});

test("without a recorded pin the reviewer prompt has no such section", () => {
  assert.equal(SECTION in buildReviewerPromptAssembled(mkReview()).sectionSizes, false);
  assert.equal(SECTION in buildReviewerPromptAssembled(mkReview({ ambientDataPins: [] })).sectionSizes, false);
});
