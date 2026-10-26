/* A prompt is a registry of section definitions rendered from one derived context. Asserted on section ids, tiers, order, claims and sizes, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLOSED_LOOP_SECTION_ID,
  buildPromptAssembled,
  buildReviewerPromptAssembled,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { GENERATOR_SECTIONS } from "@contexts/generation/infrastructure/prompt-builders/generator-sections.ts";
import { REVIEWER_SECTIONS, REVIEWER_STEP_LIMIT_SECTION_ID } from "@contexts/generation/infrastructure/prompt-builders/reviewer-sections.ts";
import { renderSections, type PromptSectionDef } from "@contexts/generation/infrastructure/prompt-builders/prompt-sections.ts";
import { STEP_LIMIT_SECTION_ID } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import type { ReviewInput } from "@contexts/generation/domain/generation-input.ts";

const LIMITS = { maxCalls: 6, perCallMs: 90_000, maxDevWrites: 12 };

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

function mkReview(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return { diff: "d", specs: [], mirrorDir: "/mirrors/org__app", e2eRelDir: "e2e", appName: "shop", mode: "diff", ...overrides };
}

test("each registry declares a section id once", () => {
  for (const registry of [GENERATOR_SECTIONS, REVIEWER_SECTIONS]) {
    const ids = registry.map((def) => def.id);
    assert.equal(new Set(ids).size, ids.length);
  }
});

test("a generator section that does not apply to the turn leaves no size and no claim in the prompt", () => {
  const without = buildPromptAssembled(mkInput(), { budgetBytes: 0 });
  assert.equal(without.sectionSizes[CLOSED_LOOP_SECTION_ID], undefined);
  assert.equal(without.claims[CLOSED_LOOP_SECTION_ID], undefined);
  const granted = buildPromptAssembled(mkInput({ closedLoop: LIMITS }), { budgetBytes: 0 });
  assert.ok((granted.sectionSizes[CLOSED_LOOP_SECTION_ID] ?? 0) > 0);
  assert.ok((granted.claims[CLOSED_LOOP_SECTION_ID] ?? []).length > 0);
});

test("a reviewer section that does not apply to the review leaves no size and no claim in the prompt", () => {
  const without = buildReviewerPromptAssembled(mkReview());
  assert.equal(without.sectionSizes[REVIEWER_STEP_LIMIT_SECTION_ID], undefined);
  assert.equal(without.claims[REVIEWER_STEP_LIMIT_SECTION_ID], undefined);
  const limited = buildReviewerPromptAssembled(mkReview({ stepLimit: 17 }));
  assert.ok((limited.sectionSizes[REVIEWER_STEP_LIMIT_SECTION_ID] ?? 0) > 0);
  assert.ok((limited.claims[REVIEWER_STEP_LIMIT_SECTION_ID] ?? []).length > 0);
});

test("the reviewer states its cap in its own section, never in the generator's", () => {
  assert.notEqual(REVIEWER_STEP_LIMIT_SECTION_ID, STEP_LIMIT_SECTION_ID);
  const limited = buildReviewerPromptAssembled(mkReview({ stepLimit: 17 }));
  assert.equal(limited.sectionSizes[STEP_LIMIT_SECTION_ID], undefined);
});

test("renderSections keeps the sections that apply, in registry order, with the tier, priority and options each render gives", () => {
  const registry: readonly PromptSectionDef<{ on: string[] }>[] = [
    { id: "first", tier: "volatile", priority: 3, applies: (ctx) => ctx.on.includes("first"), render: () => ({ content: "one", maxBytes: 9 }) },
    { id: "second", tier: "task", priority: 1, applies: (ctx) => ctx.on.includes("second"), render: () => ({ content: "two" }) },
    { id: "third", tier: "stable-prefix", priority: 0, applies: (ctx) => ctx.on.includes("third"), render: () => ({ content: "three", shedAs: "critical-recap" }) },
  ];
  const sections = renderSections(registry, { on: ["third", "first"] });
  assert.deepEqual(sections.map((s) => s.id), ["first", "third"]);
  const [first, third] = sections;
  assert.deepEqual([first?.role, first?.priority, first?.maxBytes], ["volatile", 3, 9]);
  assert.deepEqual([third?.role, third?.priority, third?.shedAs], ["stable-prefix", 0, "critical-recap"]);
  assert.deepEqual(renderSections(registry, { on: [] }), []);
});
