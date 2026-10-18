import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGFUSE, langfuseCostDetails, langfuseObservationType, langfuseUsageDetails } from "@kernel/telemetry/langfuse-mapping.ts";
import { GENAI, normalizeCodexUsage, normalizeOpenCodeUsage } from "@kernel/telemetry/genai-semconv.ts";
import { lookupAttribute } from "@kernel/telemetry/attribute-registry.ts";

test("each GenAI operation maps to the Langfuse observation type that gives it the right view", () => {
  assert.equal(langfuseObservationType(GENAI.operations.invokeAgent), "agent");
  assert.equal(langfuseObservationType(GENAI.operations.chat), "generation");
  assert.equal(langfuseObservationType(GENAI.operations.executeTool), "tool");
  assert.equal(langfuseObservationType(undefined), "span");
  assert.equal(langfuseObservationType("anything else"), "span");
});

test("usage details are Langfuse's EXCLUSIVE buckets: the conventions' inclusive input and output are taken apart", () => {
  const convention = normalizeOpenCodeUsage({ input: 100, output: 10, reasoning: 4, cacheRead: 5_000, cacheWrite: 10 });
  assert.equal(convention.input, 5_110);
  assert.deepEqual(JSON.parse(langfuseUsageDetails(convention)), { input: 100, output: 6, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 10, output_reasoning_tokens: 4 });
});

test("the exclusive buckets add up to what the conventions count, so Langfuse prices every token exactly once", () => {
  const convention = normalizeOpenCodeUsage({ input: 7, output: 30, reasoning: 12, cacheRead: 300, cacheWrite: 20 });
  const buckets = JSON.parse(langfuseUsageDetails(convention)) as Record<string, number>;
  assert.equal(Object.values(buckets).reduce((a, b) => a + b, 0), convention.input + convention.output);
});

test("a count the runtime reported inconsistently is clamped, never negative", () => {
  const buckets = JSON.parse(langfuseUsageDetails({ input: 10, output: 2, cacheRead: 50, cacheWrite: 0, reasoning: 9 })) as Record<string, number>;
  for (const value of Object.values(buckets)) assert.ok(value >= 0);
  assert.equal(buckets.input, 0);
  assert.equal(buckets.output, 0);
});

test("cost details carry the provider-reported cost, and nothing when there is none to report", () => {
  assert.deepEqual(JSON.parse(langfuseCostDetails(0.05) ?? "null"), { total: 0.05 });
  assert.equal(langfuseCostDetails(0), undefined);
  assert.equal(langfuseCostDetails(Number.NaN), undefined);
  assert.equal(langfuseCostDetails(-1), undefined);
});

test("every Langfuse key is registered and carries no content", () => {
  for (const key of Object.values(LANGFUSE.attrs)) assert.ok(lookupAttribute(key), `${key} is not registered`);
  assert.equal(lookupAttribute(LANGFUSE.attrs.usageDetails)?.content, "none");
  assert.equal(lookupAttribute(LANGFUSE.attrs.costDetails)?.content, "none");
});

test("Codex-shaped usage gives non-negative buckets that add up to the conventions' input plus output", () => {
  const usage = normalizeCodexUsage({ inputTokens: 12_000, cachedInputTokens: 9_000, outputTokens: 40, reasoningOutputTokens: 15 });
  const buckets = JSON.parse(langfuseUsageDetails(usage)) as Record<string, number>;
  assert.deepEqual(buckets, { input: 3_000, output: 25, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 0, output_reasoning_tokens: 15 });
  for (const value of Object.values(buckets)) assert.ok(value >= 0);
  assert.equal(Object.values(buckets).reduce((a, b) => a + b, 0), usage.input + usage.output);
});

test("Codex usage whose cache exceeds its input is clamped and still never negative", () => {
  const buckets = JSON.parse(langfuseUsageDetails(normalizeCodexUsage({ inputTokens: 100, cachedInputTokens: 500, outputTokens: 1, reasoningOutputTokens: 5 }))) as Record<string, number>;
  for (const value of Object.values(buckets)) assert.ok(value >= 0);
});
