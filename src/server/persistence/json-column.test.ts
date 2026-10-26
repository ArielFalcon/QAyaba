import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonColumn } from "./json-column";

function captureWarnings(fn: () => void): string[] {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

test("a valid JSON column parses and logs nothing", () => {
  const lines = captureWarnings(() => assert.deepEqual(parseJsonColumn('{"a":1}', {}, { table: "runs", column: "phase_timings", id: "r1" }), { a: 1 }));
  assert.deepEqual(lines, []);
});

test("a corrupt JSON column yields the fallback and one warning naming the table, column and row", () => {
  const lines = captureWarnings(() => assert.deepEqual(parseJsonColumn("{not json", { fallback: true }, { table: "runs", column: "phase_timings", id: "run-42" }), { fallback: true }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /runs\.phase_timings/);
  assert.match(lines[0]!, /run-42/);
});
