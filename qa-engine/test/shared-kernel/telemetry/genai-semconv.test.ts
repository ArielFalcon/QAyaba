import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOpenCodeUsage } from "@kernel/telemetry/genai-semconv.ts";

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
