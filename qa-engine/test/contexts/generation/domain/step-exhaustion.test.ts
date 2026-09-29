import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  detectStepExhaustion,
  finalStepText,
  stepExhaustionState,
  type TurnPart,
} from "@contexts/generation/domain/step-exhaustion.ts";

const STEP_EXHAUSTION_URL = new URL("../../../../src/contexts/generation/domain/step-exhaustion.ts", import.meta.url);

const maxStepsFixture = readFileSync(
  fileURLToPath(new URL("./fixtures/opencode-max-steps-instruction.txt", import.meta.url)),
  "utf8",
);
const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/exhausted-turn-outputs.json", import.meta.url)), "utf8"),
) as {
  outputs: Array<{ source: string; exhausted: boolean; text: string }>;
  turns: Array<{ source: string; parts: TurnPart[] }>;
};
const sseFixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../infrastructure/sse/fixtures/opencode-1.17.7-step-parts.json", import.meta.url),
    ),
    "utf8",
  ),
) as Array<{ type: string; properties?: { part?: { type?: string; text?: string } } }>;

const exhaustedOutputs = fixtures.outputs.filter((o) => o.exhausted);
const ordinaryOutputs = fixtures.outputs.filter((o) => !o.exhausted);

/* The joined text of every part, the way a turn's persisted output reads. */
function joinedText(parts: readonly TurnPart[]): string {
  return parts.map((p) => p.text ?? "").join("");
}

test("detects the exact recorded-output marker OpenCode 1.17.7 injects on step exhaustion", () => {
  assert.equal(detectStepExhaustion(maxStepsFixture), true);
});

test("is case-insensitive", () => {
  assert.equal(detectStepExhaustion("the MAXIMUM number of STEPS allowed has been REACHED"), true);
});

test("does not flag ordinary turn text — verified against the live-binary SSE fixture", () => {
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

test("does not flag a recorded turn output that only names a maximum, steps and a reached page apart", () => {
  assert.ok(ordinaryOutputs.length > 0);
  for (const { source, text } of ordinaryOutputs) {
    assert.equal(detectStepExhaustion(text), false, `an ordinary turn was flagged: ${source}`);
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
    "The agent hit max steps.",
    "The run exceeded the maximum steps.",
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

test("a gap of plain words is crossed but quotes, brackets, colons and line breaks end it", () => {
  assert.equal(detectStepExhaustion("maximum number of steps allowed for this task has been reached"), true);
  for (const separator of ['"', "]", ":", "\n", "…", ","]) {
    assert.equal(detectStepExhaustion(`maximum${separator} steps have been reached`), false, JSON.stringify(separator));
    assert.equal(detectStepExhaustion(`maximum steps${separator} reached`), false, JSON.stringify(separator));
    assert.equal(detectStepExhaustion(`reached${separator} the maximum steps`), false, JSON.stringify(separator));
  }
});

test("a gap longer than the bound is not crossed", () => {
  const filler = (n: number) => Array.from({ length: n }, () => "word").join(" ");
  assert.equal(detectStepExhaustion(`maximum ${filler(3)} steps ${filler(6)} reached`), true);
  assert.equal(detectStepExhaustion(`maximum ${filler(4)} steps ${filler(6)} reached`), false);
  assert.equal(detectStepExhaustion(`maximum ${filler(3)} steps ${filler(7)} reached`), false);
  assert.equal(detectStepExhaustion(`reached ${filler(6)} maximum ${filler(3)} steps`), true);
  assert.equal(detectStepExhaustion(`reached ${filler(7)} maximum ${filler(3)} steps`), false);
});

/*
 * Linear-time guard. A scan that backtracks over the whole text for every "maximum" takes minutes on a
 * megabyte and cannot be interrupted from the same thread, so a regression would hang the suite rather
 * than fail it. The first test climbs a size ladder that fails within seconds on a super-linear scan;
 * the large cases then run in a worker thread that is terminated at a deadline.
 */
const LADDER_CHARS = [8_192, 16_384, 32_768] as const;
const LADDER_RUNG_BUDGET_MS = 250;
const LARGE_INPUT_CHARS = 1_000_000;
const LARGE_INPUT_DEADLINE_MS = 10_000;

const SCAN_SHAPES = [
  ["maximum steps repeated", "maximum steps "],
  ["maximum repeated", "maximum "],
  ["maximum and steps interleaved", "maximum of steps and maximum "],
  ["reached and maximum interleaved", "reached the maximum "],
  ["token runs between the three words", "maximum a b c steps d e f g h i "],
  ["a long run of plain words after a maximum", "maximum " + "word ".repeat(200)],
] as const;

function shapeOf(unit: string, chars: number): string {
  return unit.repeat(Math.ceil(chars / unit.length));
}

test("the scan time stays flat as the input grows, on every pathological shape", () => {
  for (const [label, unit] of SCAN_SHAPES) {
    for (const chars of LADDER_CHARS) {
      const text = shapeOf(unit, chars);
      const start = performance.now();
      const detected = detectStepExhaustion(text);
      const elapsedMs = performance.now() - start;
      assert.equal(detected, false, `${label} at ${chars} chars`);
      assert.ok(elapsedMs < LADDER_RUNG_BUDGET_MS, `${label} at ${chars} chars took ${Math.round(elapsedMs)} ms`);
    }
  }
});

interface ScanResult {
  detected: boolean;
  elapsedMs: number;
}

/* Runs the scan in a worker thread and ends the worker at the deadline, so a runaway scan fails this test instead of the suite. */
function scanInWorker(unit: string, chars: number): Promise<ScanResult> {
  const source = `
    const { workerData, parentPort } = require("node:worker_threads");
    import(workerData.moduleUrl).then((mod) => {
      const text = workerData.unit.repeat(Math.ceil(workerData.chars / workerData.unit.length));
      const start = performance.now();
      const detected = mod.detectStepExhaustion(text);
      parentPort.postMessage({ detected, elapsedMs: performance.now() - start });
    });
  `;
  return new Promise<ScanResult>((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { moduleUrl: STEP_EXHAUSTION_URL.href, unit, chars },
    });
    const deadline = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`the scan did not finish within ${LARGE_INPUT_DEADLINE_MS} ms`));
    }, LARGE_INPUT_DEADLINE_MS);
    worker.once("message", (result: ScanResult) => {
      clearTimeout(deadline);
      void worker.terminate();
      resolve(result);
    });
    worker.once("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });
  });
}

for (const [label, unit] of SCAN_SHAPES) {
  test(`scans a megabyte of ${label} within the deadline and reports no exhaustion`, async () => {
    const { detected, elapsedMs } = await scanInWorker(unit, LARGE_INPUT_CHARS);
    assert.equal(detected, false);
    assert.ok(elapsedMs < LARGE_INPUT_DEADLINE_MS, `the scan took ${Math.round(elapsedMs)} ms`);
  });
}

test("still finds the notice at the end of a megabyte of noise", async () => {
  const source = `
    const { workerData, parentPort } = require("node:worker_threads");
    import(workerData.moduleUrl).then((mod) => {
      const noise = "maximum of steps and maximum ".repeat(40_000);
      parentPort.postMessage({ detected: mod.detectStepExhaustion(noise + "Maximum steps reached"), elapsedMs: 0 });
    });
  `;
  const detected = await new Promise<boolean>((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { moduleUrl: STEP_EXHAUSTION_URL.href } });
    const deadline = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`the scan did not finish within ${LARGE_INPUT_DEADLINE_MS} ms`));
    }, LARGE_INPUT_DEADLINE_MS);
    worker.once("message", (m: ScanResult) => {
      clearTimeout(deadline);
      void worker.terminate();
      resolve(m.detected);
    });
    worker.once("error", reject);
  });
  assert.equal(detected, true);
});

const text = (t: string): TurnPart => ({ type: "text", text: t });
const reasoning = (t: string): TurnPart => ({ type: "reasoning", text: t });
const stepStart: TurnPart = { type: "step-start" };
const tool: TurnPart = { type: "tool" };

test("the final step's text is the text parts after the last step start", () => {
  assert.equal(finalStepText([stepStart, text("first"), stepStart, text("second")]), "second");
  assert.equal(finalStepText([stepStart, text("only")]), "only");
});

test("text parts of the final step are joined in order and keep code and JSON verbatim", () => {
  const json = '```json\n{"specs":["a.spec.ts"]}\n```';
  assert.equal(finalStepText([stepStart, tool, text("Done. "), tool, text(json)]), `Done. ${json}`);
});

test("reasoning is left out of the final step's text", () => {
  const parts = [stepStart, reasoning("the earlier turn hit max steps"), text('{"specs":[]}')];
  assert.equal(finalStepText(parts), '{"specs":[]}');
});

test("without any step start every text part counts", () => {
  assert.equal(finalStepText([text("a"), reasoning("skipped"), text("b")]), "ab");
});

test("a final step with no text is empty, never the text of an earlier step", () => {
  assert.equal(finalStepText([stepStart, text("earlier verdict"), stepStart, tool]), "");
  assert.equal(finalStepText([stepStart, text("earlier verdict"), stepStart]), "");
});

test("a part without text contributes nothing", () => {
  assert.equal(finalStepText([stepStart, { type: "text" }, text("kept")]), "kept");
});

test("no parts give no text", () => {
  assert.equal(finalStepText([]), "");
});

test("a recovery turn whose reasoning recalls hitting max steps is exhausted as a joined output but not as its final step", () => {
  const recovery = fixtures.turns[0]!;
  assert.equal(detectStepExhaustion(joinedText(recovery.parts)), true, "the joined output carries the recalled phrase");
  assert.equal(detectStepExhaustion(finalStepText(recovery.parts)), false, "the final step is the verdict alone");
});

test("a turn whose reasoning quotes the no-op example ends in that no-op statement", () => {
  const declared = fixtures.turns[1]!;
  const statement = finalStepText(declared.parts);
  assert.match(statement, /"noop"/);
  assert.equal(statement.startsWith('{"specs":[]'), true);
  assert.equal(detectStepExhaustion(statement), false);
});

const STEPS_ROWS: ReadonlyArray<{ label: string; maxSteps: number | null; stepsUsed: number | null; finalStepText: string; expected: boolean | null }> = [
  { label: "the notice in the final step, count unknown", maxSteps: 50, stepsUsed: null, finalStepText: "Max steps reached", expected: true },
  { label: "the notice in the final step, count below the limit", maxSteps: 50, stepsUsed: 3, finalStepText: "Max steps reached", expected: true },
  { label: "the notice with no configured limit", maxSteps: null, stepsUsed: null, finalStepText: "Max steps reached", expected: true },
  { label: "a complete count equal to the limit", maxSteps: 50, stepsUsed: 50, finalStepText: "done", expected: true },
  { label: "a complete count above the limit", maxSteps: 50, stepsUsed: 51, finalStepText: "done", expected: true },
  { label: "a complete count below the limit", maxSteps: 50, stepsUsed: 49, finalStepText: "done", expected: false },
  { label: "an unknown count and no notice", maxSteps: 50, stepsUsed: null, finalStepText: "done", expected: null },
  { label: "an unknown limit and no notice", maxSteps: null, stepsUsed: 12, finalStepText: "done", expected: null },
  { label: "neither a limit nor a count and no notice", maxSteps: null, stepsUsed: null, finalStepText: "", expected: null },
];

for (const row of STEPS_ROWS) {
  test(`step exhaustion is ${String(row.expected)} for ${row.label}`, () => {
    assert.equal(
      stepExhaustionState({ maxSteps: row.maxSteps, stepsUsed: row.stepsUsed, finalStepText: row.finalStepText }),
      row.expected,
    );
  });
}
