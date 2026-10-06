import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedLineReader } from "@kernel/process-sandbox/bounded-line-reader.ts";

const MAX = 20;

function collect(): { lines: string[]; reader: BoundedLineReader } {
  const lines: string[] = [];
  return { lines, reader: new BoundedLineReader(MAX, (l) => lines.push(l)) };
}

test("whole lines are delivered in order, however the chunks fall", () => {
  const { lines, reader } = collect();
  reader.feed("first\nsec");
  reader.feed("ond\n");
  reader.feed("third\nfourth\n");
  assert.deepEqual(lines, ["first", "second", "third", "fourth"]);
});

test("a last line without a line break is delivered when the stream ends", () => {
  const { lines, reader } = collect();
  reader.feed("first\nlast");
  assert.deepEqual(lines, ["first"]);
  reader.end();
  assert.deepEqual(lines, ["first", "last"]);
});

test("a line longer than the bound that arrives in one piece is skipped, and the next line is read", () => {
  const { lines, reader } = collect();
  reader.feed(`${"z".repeat(MAX + 1)}\nshort\n`);
  assert.deepEqual(lines, ["short"]);
});

test("a line that grows past the bound across chunks is skipped whole, including what arrives after the bound was passed", () => {
  const { lines, reader } = collect();
  reader.feed("z".repeat(MAX + 5));
  reader.feed("ok looks like a line of its own\n");
  reader.feed("next\n");
  assert.deepEqual(lines, ["next"], "the continuation of the skipped line is not a line start");
});

test("a line exactly at the bound is delivered", () => {
  const { lines, reader } = collect();
  reader.feed(`${"a".repeat(MAX)}\n`);
  assert.deepEqual(lines, ["a".repeat(MAX)]);
});
