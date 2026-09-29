import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedOutputTail } from "@kernel/process-sandbox/bounded-output-tail.ts";

const KEEP = 100;

test("output within the bound is kept whole and reports nothing omitted", () => {
  const tail = new BoundedOutputTail(KEEP);
  tail.append("first line\n");
  tail.append("second line\n");
  assert.equal(tail.text(), "first line\nsecond line\n");
  assert.equal(tail.omittedChars, 0);
});

/* Lines of a fixed width, so where a cut lands inside a line is known. */
const LINE = `${"x".repeat(38)}\n`;

test("a flood keeps only the most recent output and counts everything dropped", () => {
  const tail = new BoundedOutputTail(KEEP);
  const chunks = 5000;
  for (let i = 0; i < chunks; i++) tail.append(LINE.repeat(25));
  tail.append("THE-LAST-LINE\n");

  const shown = tail.text();
  assert.ok(shown.endsWith("THE-LAST-LINE\n"), "the newest output survives");
  assert.ok(shown.length <= KEEP + 200, `the kept text stays within the bound plus its omission note (was ${shown.length})`);
  const total = LINE.length * 25 * chunks + "THE-LAST-LINE\n".length;
  const [, kept = ""] = shown.split("…\n");
  assert.equal(tail.omittedChars + kept.length, total, "every dropped char is counted, and what is kept is what is not dropped");
});

test("the bound holds after every append, not only at the end", () => {
  const tail = new BoundedOutputTail(KEEP);
  for (let i = 0; i < 400; i++) {
    tail.append(`${"y".repeat(36)}\n`);
    assert.ok(tail.text().length <= KEEP + 200, `kept text exceeded the bound after append ${i}`);
  }
});

test("a chunk larger than the bound on its own is trimmed to its tail", () => {
  const tail = new BoundedOutputTail(KEEP);
  tail.append(`${"h\n".repeat(2500)}END`);
  assert.ok(tail.text().endsWith("END"));
  assert.ok(tail.text().length <= KEEP + 200);
  assert.equal(tail.omittedChars + tail.text().split("…\n")[1]!.length, 5003);
});

test("truncated output leads with an omission note carrying the dropped count", () => {
  const tail = new BoundedOutputTail(KEEP);
  tail.append(`${"z".repeat(24)}\n`.repeat(10));
  const [note] = tail.text().split("\n");
  assert.match(note!, new RegExp(`\\b${tail.omittedChars}\\b`));
  assert.ok(tail.omittedChars > 0);
});

test("a cut through a line never leaves the rest of that line at the head of the kept text", () => {
  const tail = new BoundedOutputTail(KEEP);
  /* The cut lands inside a line: the kept text would start with the line's back half. */
  const secretLine = `token=${"S".repeat(20)}-END-OF-SECRET\n`;
  const filler = "context line\n";
  const before = "before\n";
  const cutInside = 6 + 10; /* the kept text would begin ten chars into the secret */
  const afterLen = KEEP - (secretLine.length - cutInside);
  tail.append(before + secretLine + filler.repeat(Math.ceil(afterLen / filler.length)).slice(0, afterLen - 1) + "\n");
  const [, kept = ""] = tail.text().split("…\n");
  assert.ok(!kept.includes("END-OF-SECRET"), "the fragment of the cut line is dropped");
  assert.ok(kept.startsWith("context line"), "the kept text starts at the first whole line after the cut line");
});

test("a cut that falls exactly on a line boundary keeps every line after it", () => {
  const tail = new BoundedOutputTail(KEEP);
  const lines = Array.from({ length: 20 }, (_, i) => `line-${String(i).padStart(2, "0")}-p\n`); /* 10 chars each, so the 100-char bound ends a line exactly */
  tail.append(lines.join(""));
  const kept = tail.text().split("…\n")[1]!;
  assert.equal(kept, lines.slice(-10).join(""), "the newest ten lines fill the bound with none lost to the boundary");
});

test("a flood with no line break keeps nothing rather than a fragment, and still counts what it dropped", () => {
  const tail = new BoundedOutputTail(KEEP);
  for (let i = 0; i < 100; i++) tail.append("q".repeat(1000));
  assert.doesNotMatch(tail.text(), /q/, "an unbroken run has no safe place to start the kept text");
  assert.equal(tail.omittedChars, 100_000);
  tail.append("\nlater line\n");
  assert.match(tail.text(), /later line/, "output after the flood is kept");
});

test("an empty tail renders as an empty string", () => {
  assert.equal(new BoundedOutputTail(KEEP).text(), "");
});
