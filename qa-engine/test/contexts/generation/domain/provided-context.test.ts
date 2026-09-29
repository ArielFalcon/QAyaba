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

test("sampleReadOutput strips a cat -n style tab gutter and trims", () => {
  const output = "     1\texport const longEnoughLine = 1;\n     2\tshort";
  const sampled = sampleReadOutput(output);
  assert.deepEqual(sampled, ["export const longEnoughLine = 1;"]);
});

test("sampleReadOutput strips a pipe-style gutter", () => {
  const output = "1| export const longEnoughLine = 1;";
  assert.deepEqual(sampleReadOutput(output), ["export const longEnoughLine = 1;"]);
});

test("sampleReadOutput keeps a line of exactly the minimum length and drops one char shorter", () => {
  const keptLine = "k".repeat(PROVIDED_CONTEXT_MIN_LINE_LENGTH);
  const droppedLine = "d".repeat(PROVIDED_CONTEXT_MIN_LINE_LENGTH - 1);
  assert.deepEqual(sampleReadOutput([droppedLine, keptLine].join("\n")), [keptLine]);
});

test("sampleReadOutput samples at most PROVIDED_CONTEXT_SAMPLE_LINES lines, the first ones", () => {
  const lines = Array.from({ length: PROVIDED_CONTEXT_SAMPLE_LINES + 16 }, (_, i) => `this is line number ${i} padded to be long enough`);
  const sampled = sampleReadOutput(lines.join("\n"));
  assert.deepEqual(sampled, lines.slice(0, PROVIDED_CONTEXT_SAMPLE_LINES));
});

test("indexPromptLines normalizes and filters short lines the same way as the sample", () => {
  const prompt = "     1\texport const longEnoughLine = 1;\n     2\tx";
  const index = indexPromptLines(prompt);
  assert.equal(index.has("export const longEnoughLine = 1;"), true);
  assert.equal(index.has("x"), false);
});

/* `count` distinct lines, each long enough to qualify for sampling. */
function qualifyingLines(count: number, label: string): string[] {
  return Array.from({ length: count }, (_, i) => `${label} line ${i} is long enough to qualify for sampling`);
}

test("isProvidedByPrompt needs at least PROVIDED_CONTEXT_MIN_SAMPLE_LINES sampled lines, however well they match", () => {
  const lines = qualifyingLines(PROVIDED_CONTEXT_MIN_SAMPLE_LINES, "prompt");
  const index = indexPromptLines(lines.join("\n"));
  assert.equal(isProvidedByPrompt(lines.slice(0, PROVIDED_CONTEXT_MIN_SAMPLE_LINES - 1), index), false, "one line short of the minimum");
  assert.equal(isProvidedByPrompt(lines, index), true, "exactly the minimum, all present in the prompt");
});

test("isProvidedByPrompt is true at exactly PROVIDED_CONTEXT_MATCH_RATIO of the sample and false one line below", () => {
  /* The smallest sample the ratio divides into a whole number of lines, so the match count lands exactly on the ratio. */
  const sampleSize = Array.from({ length: PROVIDED_CONTEXT_SAMPLE_LINES }, (_, i) => i + 1)
    .find((n) => n >= PROVIDED_CONTEXT_MIN_SAMPLE_LINES && Number.isInteger(n * PROVIDED_CONTEXT_MATCH_RATIO));
  assert.ok(sampleSize !== undefined, "the ratio must be exactly reachable within a full sample");
  const needed = sampleSize * PROVIDED_CONTEXT_MATCH_RATIO;
  const inPrompt = qualifyingLines(sampleSize, "prompt");
  const notInPrompt = qualifyingLines(sampleSize, "elsewhere");
  const index = indexPromptLines(inPrompt.join("\n"));

  const exactlyEnough = [...inPrompt.slice(0, needed), ...notInPrompt.slice(0, sampleSize - needed)];
  const oneShort = [...inPrompt.slice(0, needed - 1), ...notInPrompt.slice(0, sampleSize - needed + 1)];
  assert.equal(isProvidedByPrompt(exactlyEnough, index), true);
  assert.equal(isProvidedByPrompt(oneShort, index), false);
});

/* The prompt carries the commit's diff: added and removed lines wear a `+`/`-` marker and context lines
   a leading space, none of which a read of the file itself shows. */
const DIFF_LINES = [
  "const total = items.reduce((sum, item) => sum + item.price, 0);",
  "if (total > FREE_SHIPPING_THRESHOLD) applyFreeShipping(order);",
  "export function checkout(order: Order): Receipt {",
  "return buildReceipt(order, total);",
];

test("a read of lines the prompt's diff shows as added, removed or context is provided by the prompt", () => {
  const diff = [
    "diff --git a/src/checkout.ts b/src/checkout.ts",
    "@@ -10,4 +10,4 @@",
    ` ${DIFF_LINES[2]}`,
    `+  ${DIFF_LINES[0]}`,
    `-  ${DIFF_LINES[1]}`,
    `+  ${DIFF_LINES[3]}`,
  ].join("\n");
  const index = indexPromptLines(`## Diff\n${diff}\n`);
  assert.equal(isProvidedByPrompt(DIFF_LINES, index), true);
});

test("a line that itself begins with a dash still matches when the prompt shows it verbatim", () => {
  const bullets = qualifyingLines(PROVIDED_CONTEXT_MIN_SAMPLE_LINES, "prompt").map((line) => `- ${line}`);
  const index = indexPromptLines(bullets.join("\n"));
  assert.equal(isProvidedByPrompt(sampleReadOutput(bullets.join("\n")), index), true);
});

test("sampleReadOutput reads lines whatever the line ending and keeps a last line with no newline", () => {
  const first = "the first line is long enough to sample";
  const last = "the last line has no newline after it";
  assert.deepEqual(sampleReadOutput(`${first}\r\n${last}`), [first, last]);
  assert.deepEqual(sampleReadOutput(`${first}\n${last}`), [first, last]);
  assert.deepEqual(sampleReadOutput(""), []);
});

test("sampleReadOutput takes its sample from the start of an output far larger than the sample", () => {
  const lines = Array.from({ length: PROVIDED_CONTEXT_SAMPLE_LINES * 500 }, (_, i) => `line ${i} of a very large read output`);
  assert.deepEqual(sampleReadOutput(lines.join("\n")), lines.slice(0, PROVIDED_CONTEXT_SAMPLE_LINES));
});
