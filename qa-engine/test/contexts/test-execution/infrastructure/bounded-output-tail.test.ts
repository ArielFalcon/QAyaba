import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedOutputTail } from "@contexts/test-execution/infrastructure/bounded-output-tail.ts";

const KEEP = 100;

test("output within the bound is kept whole and reports nothing omitted", () => {
  const tail = new BoundedOutputTail(KEEP);
  tail.append("first line\n");
  tail.append("second line\n");
  assert.equal(tail.text(), "first line\nsecond line\n");
  assert.equal(tail.omittedChars, 0);
});

test("a flood keeps only the most recent output and counts everything dropped", () => {
  const tail = new BoundedOutputTail(KEEP);
  const chunk = "x".repeat(1000);
  const chunks = 5000;
  for (let i = 0; i < chunks; i++) tail.append(chunk);
  tail.append("THE-LAST-LINE");

  const shown = tail.text();
  assert.ok(shown.endsWith("THE-LAST-LINE"), "the newest output survives");
  assert.ok(shown.length <= KEEP + 200, `the kept text stays within the bound plus its omission note (was ${shown.length})`);
  assert.equal(tail.omittedChars + KEEP, chunk.length * chunks + "THE-LAST-LINE".length, "every dropped char is counted");
});

test("the bound holds after every append, not only at the end", () => {
  const tail = new BoundedOutputTail(KEEP);
  for (let i = 0; i < 400; i++) {
    tail.append("y".repeat(37));
    assert.ok(tail.text().length <= KEEP + 200, `kept text exceeded the bound after append ${i}`);
  }
});

test("a chunk larger than the bound on its own is trimmed to its tail", () => {
  const tail = new BoundedOutputTail(KEEP);
  tail.append(`${"h".repeat(5000)}END`);
  assert.ok(tail.text().endsWith("END"));
  assert.ok(tail.text().length <= KEEP + 200);
  assert.equal(tail.omittedChars, 5003 - KEEP);
});

test("truncated output leads with an omission note carrying the dropped count", () => {
  const tail = new BoundedOutputTail(KEEP);
  tail.append("z".repeat(KEEP + 25));
  const [note] = tail.text().split("\n");
  assert.match(note!, /\b25\b/);
  assert.equal(tail.omittedChars, 25);
});

test("an empty tail renders as an empty string", () => {
  assert.equal(new BoundedOutputTail(KEEP).text(), "");
});
