import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GENERATION_NOTE_MAX_CHARS,
  classifyGenerationEnd,
  renderGenerationNote,
} from "@contexts/generation/domain/generation-end.ts";
import { GENERATION_END, type GenerationEndKind } from "@kernel/generation-end.ts";

interface ClassifyRow {
  label: string;
  specCount: number;
  parsed: boolean;
  noopReason: string | undefined;
  exhausted: boolean;
  expected: GenerationEndKind;
}

const CLASSIFY_ROWS: readonly ClassifyRow[] = [
  { label: "specs, verdict read, no decision, not exhausted", specCount: 2, parsed: true, noopReason: undefined, exhausted: false, expected: GENERATION_END.DELIVERED },
  { label: "specs and a declared no-op (the specs win)", specCount: 2, parsed: true, noopReason: "nothing to test", exhausted: false, expected: GENERATION_END.DELIVERED },
  { label: "specs and exhaustion (exhaustion is only recorded)", specCount: 2, parsed: true, noopReason: undefined, exhausted: true, expected: GENERATION_END.DELIVERED },
  { label: "specs from an unparsed output", specCount: 1, parsed: false, noopReason: undefined, exhausted: false, expected: GENERATION_END.DELIVERED },
  { label: "specs, unparsed and exhausted", specCount: 1, parsed: false, noopReason: undefined, exhausted: true, expected: GENERATION_END.DELIVERED },
  { label: "no specs, exhausted", specCount: 0, parsed: true, noopReason: undefined, exhausted: true, expected: GENERATION_END.EXHAUSTED },
  { label: "no specs, exhausted and unparsed", specCount: 0, parsed: false, noopReason: undefined, exhausted: true, expected: GENERATION_END.EXHAUSTED },
  { label: "no specs, exhausted with a declared no-op (exhaustion wins)", specCount: 0, parsed: true, noopReason: "nothing to test", exhausted: true, expected: GENERATION_END.EXHAUSTED },
  { label: "no specs, unparsed, not exhausted", specCount: 0, parsed: false, noopReason: undefined, exhausted: false, expected: GENERATION_END.NO_VERDICT },
  { label: "no specs, unparsed with a reason (a no-op needs a parsed verdict)", specCount: 0, parsed: false, noopReason: "nothing to test", exhausted: false, expected: GENERATION_END.NO_VERDICT },
  { label: "no specs, a declared no-op", specCount: 0, parsed: true, noopReason: "nothing to test", exhausted: false, expected: GENERATION_END.DECLARED_NOOP },
  { label: "no specs, a parsed verdict and no decision", specCount: 0, parsed: true, noopReason: undefined, exhausted: false, expected: GENERATION_END.UNDECIDED_EMPTY },
  { label: "no specs and a reason that is only whitespace", specCount: 0, parsed: true, noopReason: "   ", exhausted: false, expected: GENERATION_END.UNDECIDED_EMPTY },
];

for (const row of CLASSIFY_ROWS) {
  test(`a generation with ${row.label} ends ${row.expected}`, () => {
    assert.equal(
      classifyGenerationEnd({ specCount: row.specCount, parsed: row.parsed, noopReason: row.noopReason, exhausted: row.exhausted }),
      row.expected,
    );
  });
}

const STEPS_FACTS = { maxSteps: 30, stepsUsed: 30, writeCount: 0, observationComplete: true };
const OUTPUT_TAIL = "I cannot make further tool calls; the harness was reviewed.";

test("an exhausted note carries the step count over the limit, the write count and the output tail", () => {
  const note = renderGenerationNote({ end: GENERATION_END.EXHAUSTED, turn: STEPS_FACTS, outputTail: OUTPUT_TAIL });
  assert.match(note, /30\/30/);
  assert.match(note, /writes:? 0\b/);
  assert.ok(note.includes(OUTPUT_TAIL));
});

test("a note opens with what happened before the facts, and sets the output tail apart from them", () => {
  for (const end of [GENERATION_END.EXHAUSTED, GENERATION_END.UNDECIDED_EMPTY] as const) {
    for (const repairExhausted of [false, true]) {
      const note = renderGenerationNote({ end, turn: STEPS_FACTS, outputTail: OUTPUT_TAIL, repairExhausted });
      assert.match(note, /^\S.*\(steps /, `${end} repair=${repairExhausted}`);
      assert.match(note, /\)\.\s+\S/, `${end} repair=${repairExhausted}`);
    }
  }
});

test("a note shows the steps used against a different limit, so the pair is not the limit twice", () => {
  const note = renderGenerationNote({
    end: GENERATION_END.EXHAUSTED,
    turn: { ...STEPS_FACTS, maxSteps: 40, stepsUsed: 41, writeCount: 3 },
    outputTail: "",
  });
  assert.match(note, /41\/40/);
  assert.match(note, /writes:? 3\b/);
});

test("a note says the step count is unavailable rather than showing a number when it was not observed", () => {
  const note = renderGenerationNote({
    end: GENERATION_END.EXHAUSTED,
    turn: { maxSteps: 30, stepsUsed: null, writeCount: 2, observationComplete: false },
    outputTail: "",
  });
  assert.match(note, /unavailable/);
  assert.doesNotMatch(note, /\d+\/30/);
});

test("an incomplete observation shows the write count as a lower bound", () => {
  const note = renderGenerationNote({
    end: GENERATION_END.EXHAUSTED,
    turn: { maxSteps: 30, stepsUsed: null, writeCount: 2, observationComplete: false },
    outputTail: "",
  });
  assert.match(note, />=\s?2\b/);
  const complete = renderGenerationNote({ end: GENERATION_END.EXHAUSTED, turn: { ...STEPS_FACTS, writeCount: 2 }, outputTail: "" });
  assert.doesNotMatch(complete, />=/);
});

test("a write count that was never measured is unavailable, not zero", () => {
  const note = renderGenerationNote({
    end: GENERATION_END.EXHAUSTED,
    turn: { ...STEPS_FACTS, writeCount: null },
    outputTail: "",
  });
  assert.match(note, /writes:? unavailable/);
});

test("a note without any turn stats still says both are unavailable", () => {
  const note = renderGenerationNote({ end: GENERATION_END.UNDECIDED_EMPTY, outputTail: OUTPUT_TAIL });
  assert.match(note, /steps:? [^;,.]*unavailable/);
  assert.match(note, /writes:? unavailable/);
  assert.ok(note.includes(OUTPUT_TAIL));
});

test("an exhausted repair turn is named in the note, and a main-turn exhaustion does not mention a repair", () => {
  const fromRepair = renderGenerationNote({ end: GENERATION_END.EXHAUSTED, turn: STEPS_FACTS, outputTail: "", repairExhausted: true });
  assert.match(fromRepair, /repair/i);
  const fromMain = renderGenerationNote({ end: GENERATION_END.EXHAUSTED, turn: STEPS_FACTS, outputTail: "", repairExhausted: false });
  assert.doesNotMatch(fromMain, /repair/i);
});

test("an undecided note and an exhausted note differ", () => {
  const exhausted = renderGenerationNote({ end: GENERATION_END.EXHAUSTED, turn: STEPS_FACTS, outputTail: OUTPUT_TAIL });
  const undecided = renderGenerationNote({ end: GENERATION_END.UNDECIDED_EMPTY, turn: STEPS_FACTS, outputTail: OUTPUT_TAIL });
  assert.notEqual(exhausted, undecided);
});

test("a declared no-op's note is its reason", () => {
  const reason = "The diff only renames an internal helper.";
  assert.equal(renderGenerationNote({ end: GENERATION_END.DECLARED_NOOP, noopReason: reason }), reason);
});

test("a declared no-op's reason is trimmed", () => {
  assert.equal(renderGenerationNote({ end: GENERATION_END.DECLARED_NOOP, noopReason: "  because  \n" }), "because");
});

test("a reason longer than the note bound is cut to the bound and keeps its start", () => {
  const long = `START ${"r".repeat(GENERATION_NOTE_MAX_CHARS * 2)}`;
  const note = renderGenerationNote({ end: GENERATION_END.DECLARED_NOOP, noopReason: long });
  assert.ok(note.length <= GENERATION_NOTE_MAX_CHARS, `${note.length} chars`);
  assert.ok(note.startsWith("START"));
});

test("a long output tail is cut to the bound from its start so the note keeps the end of the output", () => {
  const tail = `${"x".repeat(GENERATION_NOTE_MAX_CHARS * 3)} THE-END`;
  const note = renderGenerationNote({ end: GENERATION_END.EXHAUSTED, turn: STEPS_FACTS, outputTail: tail });
  assert.ok(note.length <= GENERATION_NOTE_MAX_CHARS, `${note.length} chars`);
  assert.ok(note.endsWith("THE-END"));
  assert.match(note, /30\/30/, "the facts survive the cut");
});

test("an output tail with line breaks reads on one line in the note", () => {
  const note = renderGenerationNote({ end: GENERATION_END.EXHAUSTED, turn: STEPS_FACTS, outputTail: "first line\n\n  second   line\n" });
  assert.doesNotMatch(note, /\n/);
  assert.ok(note.endsWith("first line second line"));
});

test("a note that fits is not cut", () => {
  const note = renderGenerationNote({ end: GENERATION_END.EXHAUSTED, turn: STEPS_FACTS, outputTail: "short tail" });
  assert.ok(note.length < GENERATION_NOTE_MAX_CHARS);
  assert.ok(note.endsWith("short tail"));
});

test("a note whose tail overflows is filled to the bound exactly", () => {
  const note = renderGenerationNote({ end: GENERATION_END.EXHAUSTED, turn: STEPS_FACTS, outputTail: "t".repeat(GENERATION_NOTE_MAX_CHARS * 2) });
  assert.equal(note.length, GENERATION_NOTE_MAX_CHARS);
});

test("the largest counts still leave the tail room inside the bound", () => {
  const note = renderGenerationNote({
    end: GENERATION_END.UNDECIDED_EMPTY,
    turn: { maxSteps: Number.MAX_SAFE_INTEGER, stepsUsed: Number.MAX_SAFE_INTEGER, writeCount: Number.MAX_SAFE_INTEGER, observationComplete: false },
    outputTail: `${"x".repeat(GENERATION_NOTE_MAX_CHARS)} THE-END`,
    repairExhausted: true,
  });
  assert.ok(note.length <= GENERATION_NOTE_MAX_CHARS, `${note.length} chars`);
  assert.ok(note.endsWith("THE-END"));
});

test("an empty output tail leaves no dangling label", () => {
  for (const outputTail of ["", "  \n "]) {
    const note = renderGenerationNote({ end: GENERATION_END.EXHAUSTED, turn: STEPS_FACTS, outputTail });
    assert.doesNotMatch(note, /:\s*$/);
    assert.match(note, /30\/30/);
  }
});

test("a step count against no configured limit shows the count alone", () => {
  const note = renderGenerationNote({ end: GENERATION_END.EXHAUSTED, turn: { ...STEPS_FACTS, maxSteps: null, stepsUsed: 12 }, outputTail: "" });
  assert.match(note, /steps 12\b/);
  assert.doesNotMatch(note, /12\//);
});
