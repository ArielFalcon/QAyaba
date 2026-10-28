import { test } from "node:test";
import assert from "node:assert/strict";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { renderBranchGap, renderCoverageGap, renderSurvivedMutant, renderSurvivedMutants, survivorFindings } from "@contexts/objective-signal/domain/render-coverage-gap.ts";

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

test("renderCoverageGap: a hub's code a candidate shares groups its uncovered lines under that candidate, as a seed of its own does", () => {
  const sharing = { ...cand("uc-1", "/one", "src/one.ts", 1, 5), sharedSeeds: [{ file: "src/store.ts", symbol: "load", range: { start: 10, end: 20 }, pages: 9 }] };
  const out = renderCoverageGap([{ file: "src/store.ts", lines: [12, 30] }], [sharing]);
  assert.equal(out, "changed lines NOT exercised by any test, by use case:\nuc-1 (page /one):\n  - src/store.ts: lines 12\nother changed lines:\n  - src/store.ts: lines 30");
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

const SURVIVOR = { file: "src/map-shell.ts", line: 67, operator: "negate condition", original: 'theme === "dark"', replacement: '!(theme === "dark")' };

test("a surviving mutant that moved a request is rendered with the request that moved, in which direction and in which test", () => {
  const text = renderSurvivedMutant(
    { ...SURVIVOR, moved: { kind: "moved", requests: { added: ["GET https://api.maps.example/styles/v1/acme/dark"], removed: ["GET https://api.maps.example/styles/v1/acme/light"] }, dom: { added: [], removed: [] }, tests: ["map.spec.ts › applies the theme"] } },
    "map.spec.ts",
  );
  for (const part of ["GET https://api.maps.example/styles/v1/acme/dark", "GET https://api.maps.example/styles/v1/acme/light", "map.spec.ts › applies the theme", "only with the mutation", "only without it"]) assert.ok(text.includes(part), part);
  assert.ok(text.includes("src/map-shell.ts:67"), "the survivor itself is still stated");
});

test("a surviving mutant that moved a line of the accessible tree names the line and the number of items the rendering left out", () => {
  const text = renderSurvivedMutant({ ...SURVIVOR, moved: { kind: "moved", requests: { added: [], removed: [] }, dom: { added: ["button: Dark theme [pressed]"], removed: [] }, tests: ["a.spec.ts › t"], omitted: 3 } });
  assert.ok(text.includes("button: Dark theme [pressed]"));
  assert.match(text, /3 more/);
});

test("a surviving mutant that moved nothing the runs observed says so, naming what was compared", () => {
  const text = renderSurvivedMutant({ ...SURVIVOR, moved: { kind: "unmoved", tests: 2 } });
  assert.match(text, /no observable moved/i);
  assert.match(text, /requests/);
  assert.match(text, /accessible tree/);
  assert.match(text, /2 test/);
});

test("a survivor with no observation, or one whose runs could not be compared, is rendered exactly as before", () => {
  const before = renderSurvivedMutant(SURVIVOR, "flows/a.spec.ts");
  assert.equal(renderSurvivedMutant({ ...SURVIVOR, moved: { kind: "unobserved", reason: "baseline" } }, "flows/a.spec.ts"), before);
  assert.doesNotMatch(before, /moved|observable/);
});

/* ── Routing a survivor: only to the spec files whose own pages moved ── */

const DARK = "GET https://api.maps.example/styles/v1/acme/dark";
const MAP_MOVED = { kind: "moved" as const, requests: { added: [DARK], removed: [] }, dom: { added: [], removed: [] }, tests: ["flows/map.spec.ts › theme"] };

test("a survivor whose pages moved in some of the spec files that reached it is a finding for those files only, each told what its own pages moved", () => {
  const findings = survivorFindings({
    ...SURVIVOR,
    specFiles: ["flows/list.spec.ts", "flows/map.spec.ts"],
    moved: MAP_MOVED,
    movedBySpec: [
      { spec: "flows/list.spec.ts", moved: { kind: "unmoved", tests: 1 } },
      { spec: "flows/map.spec.ts", moved: MAP_MOVED },
    ],
  });

  assert.deepEqual(findings.map((f) => f.spec), ["flows/map.spec.ts"]);
  assert.ok(findings[0]!.text.includes(DARK) && findings[0]!.text.includes("flows/map.spec.ts"));
});

test("a survivor whose pages moved in none of its spec files is a finding for every one of them, each told its own account", () => {
  const findings = survivorFindings({
    ...SURVIVOR,
    specFiles: ["flows/list.spec.ts", "flows/map.spec.ts"],
    moved: { kind: "unmoved", tests: 2 },
    movedBySpec: [
      { spec: "flows/list.spec.ts", moved: { kind: "unmoved", tests: 1 } },
      { spec: "flows/map.spec.ts", moved: { kind: "unobserved", reason: "no-common-test" } },
    ],
  });

  assert.deepEqual(findings.map((f) => f.spec), ["flows/list.spec.ts", "flows/map.spec.ts"]);
  assert.match(findings[0]!.text, /no observable moved/);
  assert.doesNotMatch(findings[1]!.text, /no observable moved/, "a file whose tests were not compared is told nothing of the others'");
});

test("a survivor with no per-file account reaches every spec file that ran it with what moved over all its tests, and one no spec ran is a finding of no spec", () => {
  const all = survivorFindings({ ...SURVIVOR, specFiles: ["flows/list.spec.ts", "flows/map.spec.ts"], moved: MAP_MOVED });
  assert.deepEqual(all.map((f) => f.spec), ["flows/list.spec.ts", "flows/map.spec.ts"]);
  assert.ok(all.every((f) => f.text.includes(DARK)));
  assert.deepEqual(survivorFindings(SURVIVOR).map((f) => f.spec), [undefined]);
});
