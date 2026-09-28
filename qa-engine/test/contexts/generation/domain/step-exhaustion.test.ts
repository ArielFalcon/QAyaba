import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detectStepExhaustion, MAX_STEPS_MARKER } from "@contexts/generation/domain/step-exhaustion.ts";

const maxStepsFixture = readFileSync(
  fileURLToPath(new URL("./fixtures/opencode-max-steps-instruction.txt", import.meta.url)),
  "utf8",
);
const sseFixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../infrastructure/sse/fixtures/opencode-1.17.7-step-parts.json", import.meta.url),
    ),
    "utf8",
  ),
) as Array<{ type: string; properties?: { part?: { type?: string; text?: string } } }>;

test("detects the exact recorded-output marker OpenCode 1.17.7 injects on step exhaustion", () => {
  assert.equal(detectStepExhaustion(maxStepsFixture), true);
});

test("is case-insensitive", () => {
  assert.equal(detectStepExhaustion("the MAXIMUM number of STEPS allowed has been REACHED"), true);
});

test("does not flag ordinary turn text — verified against the live-binary SSE fixture from 0.1", () => {
  const finalText = sseFixture
    .filter((e) => e.type === "message.part.updated" && e.properties?.part?.type === "text")
    .map((e) => e.properties?.part?.text ?? "")
    .join("");
  assert.equal(finalText.length > 0, true);
  assert.equal(detectStepExhaustion(finalText), false);
});

test("does not flag text that merely mentions steps without the exhaustion phrasing", () => {
  assert.equal(detectStepExhaustion("This task took 12 steps to finish."), false);
  assert.equal(detectStepExhaustion("The maximum file size was reached."), false);
});

test("MAX_STEPS_MARKER is exported for reuse by the report's drift check", () => {
  assert.equal(MAX_STEPS_MARKER instanceof RegExp, true);
  assert.equal(MAX_STEPS_MARKER.test("MAXIMUM STEPS REACHED"), true);
});
