/* ContextAssemblerAdapter must stay a thin wrap of assemble/section — same inputs, same bytes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextAssemblerAdapter } from "@contexts/generation/infrastructure/context-assembler.adapter.ts";
import { assemble as referenceAssemble, section as referenceSection } from "@contexts/generation/infrastructure/prompt-builders/context-assembler.ts";

test("assemble + section wrapper produces identical result to the reference fn", () => {
  const adapter = new ContextAssemblerAdapter(referenceAssemble, referenceSection);

  /* Build sections via both paths with the same options. */
  const OPTS = { separator: "\n\n" };

  const referenceS1 = referenceSection("task", "task", "write a login test for the flow", { priority: 1 });
  const referenceS2 = referenceSection("diff", "semi-stable", "- added LoginForm\n+ added validation", { priority: 2 });
  const referenceResult = referenceAssemble([referenceS1, referenceS2], OPTS);

  const adapterS1 = adapter.section("task", "task", "write a login test for the flow", { priority: 1 });
  const adapterS2 = adapter.section("diff", "semi-stable", "- added LoginForm\n+ added validation", { priority: 2 });
  const adapterResult = adapter.assemble([adapterS1, adapterS2], OPTS);

  assert.equal(adapterResult.text, referenceResult.text, "assembled text must match the reference fn");
  assert.deepEqual(adapterResult.sectionSizes, referenceResult.sectionSizes, "sectionSizes must match the reference fn");
});

test("window fit behavior", () => {
  const adapter = new ContextAssemblerAdapter(referenceAssemble, referenceSection);

  /* A window the prompt is over: proves the fit rule is delegated. */
  const opts = { fit: (bytes: number) => (bytes <= 20 ? ("fits" as const) : ("over" as const)) };
  const degrade = (step: number) => (step === 1 ? { content: "(not shown)", omissions: [] } : undefined);

  const referenceS = referenceSection("volatile-section", "volatile", "a very long volatile body to be given up", { priority: 99, degrade });
  const referenceStable = referenceSection("rules", "stable-prefix", "rules", { priority: 0 });
  const referenceResult = referenceAssemble([referenceS, referenceStable], opts);

  const adapterS = adapter.section("volatile-section", "volatile", "a very long volatile body to be given up", { priority: 99, degrade });
  const adapterStable = adapter.section("rules", "stable-prefix", "rules", { priority: 0 });
  const adapterResult = adapter.assemble([adapterS, adapterStable], opts);

  assert.equal(adapterResult.text, referenceResult.text);
  assert.deepEqual(adapterResult.sectionSizes, referenceResult.sectionSizes);
  assert.ok(adapterResult.text.includes("(not shown)"));
});
