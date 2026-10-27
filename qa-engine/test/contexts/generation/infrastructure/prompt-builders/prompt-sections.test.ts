/* A prompt is a registry of section definitions rendered from one derived context. Asserted on section ids, tiers, order, claims and sizes, never on prompt wording. */
import { test } from "node:test";
import { assembleDefs } from "@kernel/prompt-sections.ts";
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

test("renderSections keeps the sections that apply, in registry order, with the tier, priority, stability and options each render gives", () => {
  const registry: readonly PromptSectionDef<{ on: string[] }>[] = [
    { id: "first", tier: "volatile", priority: 3, stability: "run", reason: "r", applies: (ctx) => ctx.on.includes("first"), render: () => ({ content: "one", maxBytes: 9 }) },
    { id: "second", tier: "task", priority: 1, stability: "run", reason: "r", applies: (ctx) => ctx.on.includes("second"), render: () => ({ content: "two" }) },
    { id: "third", tier: "stable-prefix", priority: 0, stability: "static", reason: "r", applies: (ctx) => ctx.on.includes("third"), render: () => ({ content: "three", shedAs: "critical-recap" }) },
  ];
  const sections = renderSections(registry, { on: ["third", "first"] });
  assert.deepEqual(sections.map((s) => s.id), ["first", "third"]);
  const [first, third] = sections;
  assert.deepEqual([first?.role, first?.priority, first?.maxBytes, first?.stability], ["volatile", 3, 9, "run"]);
  assert.deepEqual([third?.role, third?.priority, third?.shedAs, third?.stability], ["stable-prefix", 0, "critical-recap", "static"]);
  assert.deepEqual(renderSections(registry, { on: [] }), []);
});

test("assembly opens with the static sections whatever their tier, then the run's facts, and ends with the recap; the stable prefix is measured in bytes", () => {
  const def = (id: string, tier: PromptSectionDef<{ n: number }>["tier"], priority: number, stability: "static" | "run", content: (ctx: { n: number }) => string): PromptSectionDef<{ n: number }> =>
    ({ id, tier, priority, stability, reason: "r", applies: () => true, render: (ctx) => ({ content: content(ctx) }) });
  const registry = [
    def("run-first", "stable-prefix", 0, "run", ({ n }) => `run ${n}`),
    def("rules", "semi-stable", 1, "static", () => "rules"),
    def("contract", "critical-recap", 0, "static", () => "contract"),
    def("facts", "volatile", 0, "run", ({ n }) => `facts ${n}`),
    def("task", "task", 0, "static", () => "task"),
  ];
  const one = assembleDefs(registry, { n: 1 });
  const two = assembleDefs(registry, { n: 2 });
  assert.deepEqual(Object.keys(one.sectionSizes), ["rules", "task", "run-first", "facts", "contract"]);
  assert.equal(one.stablePrefixBytes, Buffer.byteLength("rules\ntask", "utf8"));
  assert.equal(one.text.slice(0, one.stablePrefixBytes), two.text.slice(0, two.stablePrefixBytes));
  assert.equal(assembleDefs(registry.filter((d) => d.stability === "run"), { n: 1 }).stablePrefixBytes, 0);
});
