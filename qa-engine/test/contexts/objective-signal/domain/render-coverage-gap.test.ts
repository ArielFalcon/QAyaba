import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCoverageGap } from "@contexts/objective-signal/domain/render-coverage-gap.ts";

/* Enforce-mode regen's coverage-gap renderer. Expected outputs are hand-written against
   ObjectiveSignalPort.measure()'s return shape — `uncovered?: {file; lines: number[]}[]`, no
   nested `overall.ratio`, so the rendered text has no ratio-percentage prefix. Consecutive
   uncovered lines compact into ranges.
 */

test("renderCoverageGap: empty uncovered array — all covered message", () => {
  assert.equal(renderCoverageGap([]), "all changed lines are covered by the tests");
});

test("renderCoverageGap: one file, contiguous lines — compacts into a range", () => {
  const out = renderCoverageGap([{ file: "src/a.ts", lines: [10, 11, 12] }]);
  assert.equal(out, "changed lines NOT exercised by any test:\n- src/a.ts: lines 10-12");
});

test("renderCoverageGap: one file, non-contiguous lines — compacts into comma-separated parts", () => {
  const out = renderCoverageGap([{ file: "src/a.ts", lines: [3, 5, 6, 7, 20] }]);
  assert.equal(out, "changed lines NOT exercised by any test:\n- src/a.ts: lines 3, 5-7, 20");
});

test("renderCoverageGap: many files — one line per file, in input order", () => {
  const out = renderCoverageGap([
    { file: "src/a.ts", lines: [1] },
    { file: "src/b.ts", lines: [2, 3] },
  ]);
  assert.equal(
    out,
    "changed lines NOT exercised by any test:\n- src/a.ts: lines 1\n- src/b.ts: lines 2-3",
  );
});

test("renderCoverageGap: over the max (default 10) truncates and reports the remainder count", () => {
  const uncovered = Array.from({ length: 12 }, (_, i) => ({ file: `src/f${i}.ts`, lines: [1] }));
  const out = renderCoverageGap(uncovered);
  const lines = out.split("\n");
  assert.equal(lines.length, 12);
  assert.equal(lines[0], "changed lines NOT exercised by any test:");
  assert.equal(lines[11], "…and 2 more file(s)");
});

test("renderCoverageGap: a custom max truncates at the caller's own bound", () => {
  const uncovered = [
    { file: "src/a.ts", lines: [1] },
    { file: "src/b.ts", lines: [2] },
    { file: "src/c.ts", lines: [3] },
  ];
  const out = renderCoverageGap(uncovered, 2);
  assert.equal(out, "changed lines NOT exercised by any test:\n- src/a.ts: lines 1\n- src/b.ts: lines 2\n…and 1 more file(s)");
});

test("renderCoverageGap: exactly at the max — no truncation trailer", () => {
  const uncovered = [
    { file: "src/a.ts", lines: [1] },
    { file: "src/b.ts", lines: [2] },
  ];
  const out = renderCoverageGap(uncovered, 2);
  assert.equal(out, "changed lines NOT exercised by any test:\n- src/a.ts: lines 1\n- src/b.ts: lines 2");
});
