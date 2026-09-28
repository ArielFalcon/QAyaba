import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sampleReadOutput,
  indexPromptLines,
  isProvidedByPrompt,
  PROVIDED_CONTEXT_SAMPLE_LINES,
  PROVIDED_CONTEXT_MIN_LINE_LENGTH,
  PROVIDED_CONTEXT_MIN_SAMPLE_LINES,
  PROVIDED_CONTEXT_MATCH_RATIO,
} from "@contexts/generation/domain/provided-context.ts";

test("exported thresholds match the design constants (D8)", () => {
  assert.equal(PROVIDED_CONTEXT_SAMPLE_LINES, 24);
  assert.equal(PROVIDED_CONTEXT_MIN_LINE_LENGTH, 12);
  assert.equal(PROVIDED_CONTEXT_MIN_SAMPLE_LINES, 3);
  assert.equal(PROVIDED_CONTEXT_MATCH_RATIO, 0.8);
});

test("sampleReadOutput strips a cat -n style tab gutter and trims", () => {
  const output = "     1\texport const longEnoughLine = 1;\n     2\tshort";
  const sampled = sampleReadOutput(output);
  assert.deepEqual(sampled, ["export const longEnoughLine = 1;"]);
});

test("sampleReadOutput strips a pipe-style gutter", () => {
  const output = "1| export const longEnoughLine = 1;";
  assert.deepEqual(sampleReadOutput(output), ["export const longEnoughLine = 1;"]);
});

test("sampleReadOutput drops lines shorter than the minimum length after normalization", () => {
  const output = ["short", "also short", "this line is definitely long enough"].join("\n");
  assert.deepEqual(sampleReadOutput(output), ["this line is definitely long enough"]);
});

test("sampleReadOutput caps at PROVIDED_CONTEXT_SAMPLE_LINES even with more qualifying lines", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `this is line number ${i} padded to be long enough`);
  const sampled = sampleReadOutput(lines.join("\n"));
  assert.equal(sampled.length, PROVIDED_CONTEXT_SAMPLE_LINES);
});

test("indexPromptLines normalizes and filters short lines the same way as the sample", () => {
  const prompt = "     1\texport const longEnoughLine = 1;\n     2\tx";
  const index = indexPromptLines(prompt);
  assert.equal(index.has("export const longEnoughLine = 1;"), true);
  assert.equal(index.has("x"), false);
});

test("isProvidedByPrompt requires at least PROVIDED_CONTEXT_MIN_SAMPLE_LINES sampled lines", () => {
  const index = indexPromptLines("this exact matching line qualifies here\nthis exact matching line qualifies here");
  const provided = isProvidedByPrompt(
    ["this exact matching line qualifies here", "this exact matching line qualifies here"],
    index,
  );
  assert.equal(provided, false);
});

test("isProvidedByPrompt is true at exactly the 80% match ratio with enough samples", () => {
  const promptLines = [
    "alpha line that is long enough to qualify",
    "bravo line that is long enough to qualify",
    "charlie line that is long enough to qualify",
    "delta line that is long enough to qualify",
  ];
  const index = indexPromptLines(promptLines.join("\n"));
  const sampled = [...promptLines, "echo line NOT present in the prompt at all"];
  assert.equal(isProvidedByPrompt(sampled, index), true);
});

test("isProvidedByPrompt is false below the 80% match ratio", () => {
  const promptLines = ["alpha line that is long enough to qualify", "bravo line that is long enough to qualify"];
  const index = indexPromptLines(promptLines.join("\n"));
  const sampled = [...promptLines, "unrelated line not present in the prompt"];
  assert.equal(isProvidedByPrompt(sampled, index), false);
});
