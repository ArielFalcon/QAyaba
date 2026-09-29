import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detectStepExhaustion } from "@contexts/generation/domain/step-exhaustion.ts";

const maxStepsFixture = readFileSync(
  fileURLToPath(new URL("./fixtures/opencode-max-steps-instruction.txt", import.meta.url)),
  "utf8",
);
const exhaustedOutputs = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/exhausted-turn-outputs.json", import.meta.url)), "utf8"),
) as Array<{ source: string; text: string }>;
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

test("detects the step-limit notice in every recorded exhausted turn output", () => {
  assert.ok(exhaustedOutputs.length > 0);
  for (const { source, text } of exhaustedOutputs) {
    assert.equal(detectStepExhaustion(text), true, `an exhausted turn was not detected: ${source}`);
  }
});

test("detects the notice however the model words it, whichever of the two orders it uses", () => {
  for (const text of [
    "Maximum steps for this agent have been reached",
    "Max steps reached before writing files",
    '{"note":"Max steps reached … no spec authored"}',
    "CRITICAL - MAXIMUM STEPS REACHED",
    "The maximum number of steps allowed for this task has been reached.",
    "I've reached the maximum number of steps.",
  ]) {
    assert.equal(detectStepExhaustion(text), true, text);
  }
});

test("does not flag a generator verdict whose scenario names the words far apart", () => {
  const verdict =
    '{"specs":[{"objective":"Covers the maximum length validation on the name field",' +
    '"steps":["open the form","type 51 characters","assert the dashboard is reached"]}]}';
  assert.equal(detectStepExhaustion(verdict), false);
});

test("does not flag prose that mentions a maximum, test steps and a reached page in different sentences", () => {
  const prose =
    "The quantity input enforces its maximum of 10; test steps fill the field and submit, " +
    "and the assertion verifies the cart page is reached.";
  assert.equal(detectStepExhaustion(prose), false);
});

/* Behavioral bound, not a benchmark: a scan that backtracks over the whole text for every "maximum" takes minutes on a megabyte, a linear one takes milliseconds. */
const LARGE_INPUT_CHARS = 1_000_000;
const GENEROUS_SCAN_BUDGET_MS = 1000;

for (const [label, unit] of [
  ["maximum steps repeated", "maximum steps "],
  ["maximum repeated", "maximum "],
  ["maximum and steps interleaved", "maximum of steps and maximum "],
  ["reached and maximum interleaved", "reached the maximum "],
] as const) {
  test(`scans a megabyte of ${label} in bounded time and reports no exhaustion`, () => {
    const text = unit.repeat(Math.ceil(LARGE_INPUT_CHARS / unit.length));
    const start = performance.now();
    const detected = detectStepExhaustion(text);
    const elapsedMs = performance.now() - start;
    assert.equal(detected, false);
    assert.ok(elapsedMs < GENEROUS_SCAN_BUDGET_MS, `the scan took ${Math.round(elapsedMs)} ms`);
  });
}
