import { test } from "node:test";
import assert from "node:assert/strict";
import { codexUsageAsRuntime, normalizeCodexUsage, normalizeOpenCodeUsage } from "@kernel/telemetry/genai-semconv.ts";

test("OpenCode's input excludes the cache; the conventions' input includes it", () => {
  assert.deepEqual(normalizeOpenCodeUsage({ input: 100, output: 20, reasoning: 5, cacheRead: 9_000, cacheWrite: 300 }), {
    input: 9_400,
    output: 20,
    cacheRead: 9_000,
    cacheWrite: 300,
    reasoning: 5,
  });
});

test("a step with no cache keeps its input as reported", () => {
  assert.equal(normalizeOpenCodeUsage({ input: 7, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }).input, 7);
});

test("Codex's input already includes the cache: it is shaped like OpenCode's so the one normalization gives the conventions' count back", () => {
  const usage = { inputTokens: 12_000, cachedInputTokens: 9_000, outputTokens: 40, reasoningOutputTokens: 15 };
  assert.deepEqual(codexUsageAsRuntime(usage), { input: 3_000, output: 40, reasoning: 15, cacheRead: 9_000, cacheWrite: 0 });
  assert.deepEqual(normalizeCodexUsage(usage), { input: 12_000, output: 40, cacheRead: 9_000, cacheWrite: 0, reasoning: 15 });
});

test("a Codex cached count above its input is clamped to the input rather than made negative", () => {
  const shaped = codexUsageAsRuntime({ inputTokens: 100, cachedInputTokens: 500, outputTokens: 1, reasoningOutputTokens: 0 });
  assert.equal(shaped.input, 0);
  assert.equal(shaped.cacheRead, 100);
});
