import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedWholeOutput } from "@kernel/process-sandbox/bounded-whole-output.ts";

test("output up to the bound is kept whole and is not over the bound", () => {
  const out = new BoundedWholeOutput(10);
  out.append("12345");
  out.append("67890");
  assert.equal(out.text(), "1234567890");
  assert.equal(out.exceeded, false);
});

test("the chunk that would pass the bound marks the output exceeded and is not partly kept", () => {
  const out = new BoundedWholeOutput(10);
  out.append("12345678");
  out.append("9012");
  assert.equal(out.exceeded, true);
  assert.equal(out.text(), "12345678", "a truncated document is never handed out as if it were whole");
});

test("once exceeded, later chunks are ignored even if they would fit", () => {
  const out = new BoundedWholeOutput(10);
  out.append("12345678");
  out.append("9012");
  out.append("x");
  assert.equal(out.text(), "12345678");
  assert.equal(out.exceeded, true);
});
