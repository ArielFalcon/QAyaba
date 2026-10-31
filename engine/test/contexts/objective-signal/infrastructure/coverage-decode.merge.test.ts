/* The lines of a file a collection holds are bounded across all its dumps: a dump past the bound is refused, and the collection stops growing at it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeDecodedDump } from "@contexts/objective-signal/infrastructure/coverage-decode.ts";
import { MAX_V8_COVERED_LINES_PER_FILE } from "@contexts/objective-signal/infrastructure/v8-source-map.ts";

const FILE = "src/a.ts";

function dump(executable: number[]): Buffer {
  return Buffer.from(JSON.stringify({ refused: false, covered: [[FILE, [1]]], executable: [[FILE, executable]], scripts: { total: 1, withSourceMap: 1 }, branches: [] }));
}

const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, i) => from + i);

test("a dump whose lines carry a file past the bound across the collection is refused", () => {
  const executable = new Map<string, Set<number>>([[FILE, new Set(range(1, MAX_V8_COVERED_LINES_PER_FILE))]]);
  const merged = mergeDecodedDump("late.json", dump([MAX_V8_COVERED_LINES_PER_FILE + 1]), { executable });
  assert.equal(merged, undefined);
});

test("a dump that brings a file exactly to the bound is used", () => {
  const executable = new Map<string, Set<number>>([[FILE, new Set(range(1, MAX_V8_COVERED_LINES_PER_FILE - 1))]]);
  const merged = mergeDecodedDump("exact.json", dump([MAX_V8_COVERED_LINES_PER_FILE]), { executable });
  assert.ok(merged !== undefined);
  assert.equal(executable.get(FILE)!.size, MAX_V8_COVERED_LINES_PER_FILE);
});

test("the collection stops growing at the bound however many lines the refused dump holds", () => {
  const executable = new Map<string, Set<number>>([[FILE, new Set(range(1, MAX_V8_COVERED_LINES_PER_FILE))]]);
  mergeDecodedDump("flood.json", dump(range(MAX_V8_COVERED_LINES_PER_FILE + 1, 50_000)), { executable });
  assert.ok(executable.get(FILE)!.size <= MAX_V8_COVERED_LINES_PER_FILE + 1);
});
