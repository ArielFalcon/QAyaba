import { test } from "node:test";
import assert from "node:assert/strict";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { renderBranchGap, renderCoverageGap, renderSurvivedMutant, renderSurvivedMutants } from "@contexts/objective-signal/domain/render-coverage-gap.ts";

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

test("renderCoverageGap: every file is listed, however many the gap has", () => {
  const uncovered = Array.from({ length: 12 }, (_, i) => ({ file: `src/f${i}.ts`, lines: [1] }));
  const lines = renderCoverageGap(uncovered).split("\n");
  assert.equal(lines.length, 13);
  assert.equal(lines[0], "changed lines NOT exercised by any test:");
  assert.equal(lines[12], "- src/f11.ts: lines 1");
});

/* ── Grouped by the use case whose seeds hold the lines ── */

const cand = (id: string, route: string, file: string, start: number, end: number) => ({
  id, entry: { kind: "page" as const, repo: "web", route }, tier: "direct" as const, basis: "graph" as const, evidence: [], seeds: [{ file, symbol: "s", range: { start, end } }],
  confidence: 1, reachability: "page" as const, pages: [], existingSpecs: [],
});

test("renderCoverageGap: with candidates, the uncovered lines are grouped under the candidate whose seeds hold them", () => {
  const out = renderCoverageGap(
    [{ file: "src/a.ts", lines: [2, 3, 12, 40] }],
    [cand("uc-1", "/one", "src/a.ts", 1, 5), cand("uc-2", "/two", "src/a.ts", 10, 20)],
  );
  assert.equal(out, "changed lines NOT exercised by any test, by use case:\nuc-1 (page /one):\n  - src/a.ts: lines 2-3\nuc-2 (page /two):\n  - src/a.ts: lines 12\nother changed lines:\n  - src/a.ts: lines 40");
});

test("renderCoverageGap: candidates that hold none of the uncovered lines leave the ungrouped text as it was", () => {
  const plain = renderCoverageGap([{ file: "src/a.ts", lines: [40] }]);
  assert.equal(renderCoverageGap([{ file: "src/a.ts", lines: [40] }], [cand("uc-1", "/one", "src/a.ts", 1, 5)]), plain);
  assert.equal(renderCoverageGap([{ file: "src/a.ts", lines: [40] }], []), plain);
});

test("renderBranchGap: the arms on changed lines no test ran, one line each with where and which arm; nothing when every arm ran", () => {
  assert.equal(renderBranchGap([]), "");
  const [heading, ...items] = renderBranchGap([
    { file: "src/store.ts", line: 57, kind: "if", arm: "else" },
    { file: "src/store.html", line: 12, kind: "conditional", arm: "false" },
  ]).split("\n");
  assert.match(heading!, /:$/, "a heading introduces the list");
  assert.deepEqual(items, ["- src/store.ts:57 if: else", "- src/store.html:12 conditional: false"]);
});

test("renderBranchGap: every arm is listed, however many the gap has", () => {
  const arms = Array.from({ length: 24 }, (_, i) => ({ file: "src/a.ts", line: i + 1, kind: "if", arm: "else" }));
  const lines = renderBranchGap(arms).split("\n");
  assert.equal(lines.length, 25);
  assert.equal(lines.at(-1), "- src/a.ts:24 if: else");
});

test("renderCoverageGap: a candidate seeded by a whole file holds that file's uncovered lines", () => {
  const candidate: UseCaseCandidate = { id: "uc-1", entry: { kind: "page", repo: "web", route: "/orders" }, tier: "direct", basis: "implementation", evidence: [], seeds: [{ file: "src/a.ts", symbol: "*" }], confidence: 1, reachability: "page", pages: [], existingSpecs: [] };

  const out = renderCoverageGap([{ file: "src/a.ts", lines: [4, 5] }, { file: "src/b.ts", lines: [1] }], [candidate]);

  assert.match(out, /uc-1 \(page \/orders\):\n  - src\/a\.ts: lines 4-5/);
  assert.match(out, /other changed lines:\n  - src\/b\.ts: lines 1/);
});

test("a surviving mutant is rendered as the fact that its line ran under the spec, the mutation applied and no test failed", () => {
  const text = renderSurvivedMutant({ file: "src/store.ts", line: 12, operator: "negate condition", original: "x === 1", replacement: "!(x === 1)" }, "flows/a.spec.ts");
  for (const part of ["flows/a.spec.ts", "src/store.ts:12", "negate condition", "x === 1", "!(x === 1)"]) assert.ok(text.includes(part), part);
});

test("every surviving mutant of a gap is listed, and none render nothing", () => {
  assert.equal(renderSurvivedMutants([]), "");
  const many = Array.from({ length: 14 }, (_, i) => ({ file: "src/a.ts", line: i + 1, operator: "swap" }));
  const text = renderSurvivedMutants(many);
  for (const line of [1, 2, 13, 14]) assert.ok(text.includes(`src/a.ts:${line} `), String(line));
});
