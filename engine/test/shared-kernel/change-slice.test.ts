/* The change map and the slice a flow must exercise: every owned hunk kept whole, everything else relevant referenced. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChangeMap } from "@kernel/change-map.ts";
import { sliceFor, unassignedOf } from "@kernel/change-slice.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { decisionRankOf, type ChangedDecision } from "@kernel/changed-decision.ts";

function fileDiff(path: string, hunks: ReadonlyArray<{ start: number; added: number; removed?: number }>): string {
  const body = hunks.map((h) => {
    const removed = h.removed ?? 0;
    return [
      `@@ -${h.start},${removed + 1} +${h.start},${h.added + 1} @@`,
      " ctx",
      ...Array.from({ length: removed }, (_, i) => `-gone ${h.start + i}`),
      ...Array.from({ length: h.added }, (_, i) => `+new ${h.start + i}`),
    ].join("\n");
  });
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...body, ""].join("\n");
}

function candidate(id: string, seeds: UseCaseCandidate["seeds"], sharedSeeds?: UseCaseCandidate["sharedSeeds"]): UseCaseCandidate {
  return {
    id, entry: { kind: "page", route: `/${id}` }, tier: "direct", basis: "map-link", evidence: [], seeds,
    ...(sharedSeeds ? { sharedSeeds } : {}),
    confidence: 1, reachability: "page", pages: [`/${id}`], existingSpecs: [],
  } as unknown as UseCaseCandidate;
}

const cart = fileDiff("src/cart.ts", [{ start: 3, added: 2 }, { start: 40, added: 1, removed: 1 }]);
const page = fileDiff("src/page.html", [{ start: 1, added: 3 }]);
const style = fileDiff("src/page.css", [{ start: 1, added: 2 }]);
const shop = fileDiff("src/shop.ts", [{ start: 10, added: 2 }]);
const spec = fileDiff("src/cart.test.ts", [{ start: 1, added: 4 }]);
const lock = fileDiff("package-lock.json", [{ start: 1, added: 9 }]);

test("the map lists each changed file once with its kind, line counts, flags and the candidates it seeds", () => {
  const diff = cart + page + spec + lock;
  const a = candidate("uc-a", [{ file: "src/cart.ts", symbol: "total", range: { start: 1, end: 10 } }]);
  const map = buildChangeMap({ diff, candidates: [a] });
  assert.deepEqual(map.files.map((f) => f.path), ["src/cart.ts", "src/page.html", "src/cart.test.ts", "package-lock.json"]);
  const byPath = new Map(map.files.map((f) => [f.path, f]));
  assert.equal(byPath.get("src/cart.ts")!.kind, "typescript");
  assert.equal(byPath.get("src/cart.ts")!.added, 3);
  assert.equal(byPath.get("src/cart.ts")!.removed, 1);
  assert.deepEqual(byPath.get("src/cart.ts")!.seededBy, ["uc-a"]);
  assert.equal(byPath.get("src/page.html")!.kind, "other");
  assert.equal(byPath.get("src/cart.test.ts")!.isTest, true);
  assert.equal(byPath.get("package-lock.json")!.fileClass, "generated");
});

test("a slice holds every hunk overlapping a seed, whole, and the other hunks as references", () => {
  const diff = cart + shop;
  const a = candidate("uc-a", [{ file: "src/cart.ts", symbol: "total", range: { start: 1, end: 10 } }]);
  const b = candidate("uc-b", [{ file: "src/shop.ts", symbol: "buy", range: { start: 1, end: 99 } }]);
  const map = buildChangeMap({ diff, candidates: [a, b] });
  const slice = sliceFor(map, diff, ["uc-a"]);
  assert.deepEqual(slice.owned.map((o) => `${o.hunk.file}:${o.hunk.newStart}`), ["src/cart.ts:3"]);
  assert.deepEqual(slice.owned[0]!.candidateIds, ["uc-a"]);
  assert.deepEqual(
    slice.references.map((r) => [r.path, r.start, r.why]),
    [["src/cart.ts", 40, "unassigned"], ["src/shop.ts", 10, "owned-by-other-flow"]],
  );
  assert.equal(slice.references[0]!.added, 1);
  assert.equal(slice.references[0]!.removed, 1);
  assert.equal(slice.references[0]!.kind, "typescript");
});

test("a new file of 300 lines is one owned hunk kept whole", () => {
  const diff = fileDiff("src/big.ts", [{ start: 1, added: 300 }]);
  const a = candidate("uc-a", [{ file: "src/big.ts", symbol: "big", range: { start: 5, end: 6 } }]);
  const slice = sliceFor(buildChangeMap({ diff, candidates: [a] }), diff, ["uc-a"]);
  assert.equal(slice.owned.length, 1);
  assert.equal(slice.owned[0]!.hunk.lines.filter((l) => l.startsWith("+")).length, 300);
  assert.deepEqual(slice.references, []);
});

test("a whole-file seed takes every hunk of its file", () => {
  const a = candidate("uc-a", [{ file: "src/cart.ts", symbol: "*" }]);
  const slice = sliceFor(buildChangeMap({ diff: cart, candidates: [a] }), cart, ["uc-a"]);
  assert.deepEqual(slice.owned.map((o) => o.hunk.newStart), [3, 40]);
});

test("shared seeds own hunks too", () => {
  const a = candidate("uc-a", [], [{ file: "src/cart.ts", symbol: "hub", range: { start: 38, end: 45 }, pages: 9 }]);
  const slice = sliceFor(buildChangeMap({ diff: cart, candidates: [a] }), cart, ["uc-a"]);
  assert.deepEqual(slice.owned.map((o) => o.hunk.newStart), [40]);
});

test("a hunk serving two candidates appears once with both ids", () => {
  const a = candidate("uc-a", [{ file: "src/cart.ts", symbol: "total", range: { start: 1, end: 10 } }]);
  const b = candidate("uc-b", [{ file: "src/cart.ts", symbol: "sum", range: { start: 4, end: 5 } }]);
  const slice = sliceFor(buildChangeMap({ diff: cart, candidates: [a, b] }), cart, ["uc-a", "uc-b"]);
  assert.equal(slice.owned.length, 1);
  assert.deepEqual(slice.owned[0]!.candidateIds, ["uc-a", "uc-b"]);
});

test("test files, lockfiles and generated files are only referenced, even under a whole-file seed", () => {
  const diff = cart + spec + lock;
  const a = candidate("uc-a", [
    { file: "src/cart.ts", symbol: "*" },
    { file: "src/cart.test.ts", symbol: "*" },
    { file: "package-lock.json", symbol: "*" },
  ]);
  const slice = sliceFor(buildChangeMap({ diff, candidates: [a] }), diff, ["uc-a"]);
  assert.ok(slice.owned.every((o) => o.hunk.file === "src/cart.ts"));
  assert.deepEqual(slice.references.map((r) => [r.path, r.why]), [["src/cart.test.ts", "test-file"], ["package-lock.json", "generated"]]);
});

test("owned hunks rank code, then other kinds, then styles, then diff order; a decision rank refines within a class", () => {
  const diff = style + page + cart + shop;
  const a = candidate("uc-a", [
    { file: "src/page.css", symbol: "*" }, { file: "src/page.html", symbol: "*" },
    { file: "src/cart.ts", symbol: "*" }, { file: "src/shop.ts", symbol: "*" },
  ]);
  const map = buildChangeMap({ diff, candidates: [a] });
  const order = (s: ReturnType<typeof sliceFor>) => s.owned.map((o) => `${o.hunk.file}:${o.hunk.newStart}`);
  assert.deepEqual(order(sliceFor(map, diff, ["uc-a"])), ["src/cart.ts:3", "src/cart.ts:40", "src/shop.ts:10", "src/page.html:1", "src/page.css:1"]);
  const ranked = sliceFor(map, diff, ["uc-a"], { decisionRank: (h) => (h.file === "src/shop.ts" ? 0 : 1) });
  assert.deepEqual(order(ranked).slice(0, 3), ["src/shop.ts:10", "src/cart.ts:3", "src/cart.ts:40"]);
  assert.deepEqual(order(sliceFor(map, diff, ["uc-a"])), order(sliceFor(map, diff, ["uc-a"])));
});

test("the rank of a decision listing puts the hunks holding a changed decision first within their class, the rest in diff order", () => {
  const diff = page + cart + shop;
  const a = candidate("uc-a", [{ file: "src/page.html", symbol: "*" }, { file: "src/cart.ts", symbol: "*" }, { file: "src/shop.ts", symbol: "*" }]);
  const map = buildChangeMap({ diff, candidates: [a] });
  const decisions: ChangedDecision[] = [{ file: "src/cart.ts", line: 41, kind: "if", arms: [{ label: "then", line: 41 }, { label: "else" }] }];
  const ranked = sliceFor(map, diff, ["uc-a"], { decisionRank: decisionRankOf(decisions) });
  assert.deepEqual(ranked.owned.map((o) => `${o.hunk.file}:${o.hunk.newStart}`), ["src/cart.ts:40", "src/cart.ts:3", "src/shop.ts:10", "src/page.html:1"]);
  assert.deepEqual(sliceFor(map, diff, ["uc-a"], { decisionRank: decisionRankOf([]) }).owned.map((o) => `${o.hunk.file}:${o.hunk.newStart}`), ["src/cart.ts:3", "src/cart.ts:40", "src/shop.ts:10", "src/page.html:1"]);
});

test("with no slices, the unassigned part is the whole diff", () => {
  const diff = cart + page + shop;
  const map = buildChangeMap({ diff, candidates: [] });
  const rest = unassignedOf(map, diff, []);
  assert.deepEqual(rest.map((u) => `${u.hunk.file}:${u.hunk.newStart}`), ["src/cart.ts:3", "src/cart.ts:40", "src/page.html:1", "src/shop.ts:10"]);
});

test("the unassigned part of two slices excludes exactly their hunks and never lists a reference file", () => {
  const diff = cart + shop + page + spec;
  const a = candidate("uc-a", [{ file: "src/cart.ts", symbol: "total", range: { start: 1, end: 10 } }]);
  const b = candidate("uc-b", [{ file: "src/shop.ts", symbol: "*" }]);
  const map = buildChangeMap({ diff, candidates: [a, b] });
  const slices = [sliceFor(map, diff, ["uc-a"]), sliceFor(map, diff, ["uc-b"])];
  assert.deepEqual(unassignedOf(map, diff, slices).map((u) => `${u.hunk.file}:${u.hunk.newStart}`), ["src/cart.ts:40", "src/page.html:1"]);
});
