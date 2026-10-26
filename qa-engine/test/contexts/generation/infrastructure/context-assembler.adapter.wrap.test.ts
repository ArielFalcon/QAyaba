/* ContextAssemblerAdapter must stay a thin wrap of assemble/section — same inputs, same bytes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextAssemblerAdapter } from "@contexts/generation/infrastructure/context-assembler.adapter.ts";
import { assemble as referenceAssemble, section as referenceSection } from "@contexts/generation/infrastructure/prompt-builders/context-assembler.ts";

test("assemble + section wrapper produces identical result to the reference fn", () => {
  const adapter = new ContextAssemblerAdapter(referenceAssemble, referenceSection);

  /* Build sections via both paths using an arbitrary budget (NOT roleWindowBytes — catalog-independent) */
  const BUDGET = 50_000;

  const referenceS1 = referenceSection("task", "task", "write a login test for the flow", { priority: 1 });
  const referenceS2 = referenceSection("diff", "semi-stable", "- added LoginForm\n+ added validation", { priority: 2 });
  const referenceResult = referenceAssemble([referenceS1, referenceS2], { budgetBytes: BUDGET });

  const adapterS1 = adapter.section("task", "task", "write a login test for the flow", { priority: 1 });
  const adapterS2 = adapter.section("diff", "semi-stable", "- added LoginForm\n+ added validation", { priority: 2 });
  const adapterResult = adapter.assemble([adapterS1, adapterS2], { budgetBytes: BUDGET });

  assert.equal(adapterResult.text, referenceResult.text, "assembled text must match the reference fn");
  assert.deepEqual(adapterResult.sectionSizes, referenceResult.sectionSizes, "sectionSizes must match the reference fn");
});

test("budget shedding behavior", () => {
  const adapter = new ContextAssemblerAdapter(referenceAssemble, referenceSection);

  /* Use a very tight budget to trigger shedding — proves the shedding algorithm is delegated */
  const TIGHT_BUDGET = 20; /* very small: forces shedding */

  const referenceS = referenceSection("volatile-section", "volatile", "a very long volatile body to be shed", { priority: 99 });
  const referenceStable = referenceSection("rules", "stable-prefix", "rules", { priority: 0 });
  const referenceResult = referenceAssemble([referenceS, referenceStable], { budgetBytes: TIGHT_BUDGET });

  const adapterS = adapter.section("volatile-section", "volatile", "a very long volatile body to be shed", { priority: 99 });
  const adapterStable = adapter.section("rules", "stable-prefix", "rules", { priority: 0 });
  const adapterResult = adapter.assemble([adapterS, adapterStable], { budgetBytes: TIGHT_BUDGET });

  assert.equal(adapterResult.text, referenceResult.text);
  assert.deepEqual(adapterResult.sectionSizes, referenceResult.sectionSizes);
});
