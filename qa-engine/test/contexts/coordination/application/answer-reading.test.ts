import { test } from "node:test";
import assert from "node:assert/strict";
import { readEntries, readOneOf } from "@contexts/coordination/application/answer-reading.ts";

const SECRET = "hunter2-correct-horse-battery";
const scrub = (text: string): string => text.replaceAll(SECRET, "[REDACTED]");

test("a value an entry quotes is redacted before it is cut, so no start of a secret the cut would split is kept", () => {
  const typed = `${"x".repeat(70)}${SECRET}`;
  const { unreadable } = readEntries([{ action: typed }], "review", (entry) => readOneOf((entry as { action: unknown }).action, ["revise", "replace"] as const, "action"), scrub);
  assert.equal(unreadable.length, 1);
  assert.ok(!unreadable[0]!.reason.includes("hunter2"), unreadable[0]!.reason);
  assert.match(unreadable[0]!.reason, /not one of revise, replace/);
});

test("a short value an entry quotes is named back, and a readable one is read", () => {
  const { entries, unreadable } = readEntries(["revise", "nope"], "review", (entry) => readOneOf(entry, ["revise", "replace"] as const, "action"), scrub);
  assert.deepEqual(entries, ["revise"]);
  assert.equal(unreadable[0]!.reason, 'action is "nope", not one of revise, replace');
});
