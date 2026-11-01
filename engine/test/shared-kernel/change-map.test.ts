/* The one seed definition: a changed file seeds a use case through its own seeds or through the code a hub shares with it, and every reader of seeds asks the same question. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChangeMap, candidateSeeds, candidatesSeededBy, changedCodeOf, seedingOf } from "@kernel/change-map.ts";
import { isChangedCode } from "@kernel/file-classes.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import { pageCandidate } from "../support/use-case-candidate.ts";

const hub = { file: "src/store.ts", symbol: "load", range: { start: 1, end: 40 }, pages: 9 };
const list = pageCandidate("/list", undefined, { id: "uc-list", seeds: [{ file: "src/list.ts", symbol: "render" }], sharedSeeds: [hub] });
const map = pageCandidate("/map", undefined, { id: "uc-map", seeds: [{ file: "src/store.ts", symbol: "load" }] });

test("a file a candidate holds only as a hub's shared code seeds it, as a shared seed", () => {
  assert.equal(seedingOf("src/store.ts", list), "shared");
  assert.equal(seedingOf("src/list.ts", list), "direct");
  assert.equal(seedingOf("src/other.ts", list), undefined);
  assert.deepEqual(candidateSeeds(list).map((s) => s.file), ["src/list.ts", "src/store.ts"]);
});

test("the candidates a file seeds come direct first, then shared, each in the order given, and paths compare in one canonical form", () => {
  assert.deepEqual(candidatesSeededBy("src/store.ts", [list, map]).map((c) => c.id), ["uc-map", "uc-list"]);
  assert.deepEqual(candidatesSeededBy("./src\\store.ts", [list, map]).map((c) => c.id), ["uc-map", "uc-list"]);
  assert.deepEqual(candidatesSeededBy("packages/a/src/store.ts", [list, map]), [], "a file is equal to another, never a suffix of it");
  assert.deepEqual(candidatesSeededBy("src/store.ts", []), []);
});

test("the change map lists a file under every candidate it seeds, directly or as shared code", () => {
  const diff = ["diff --git a/src/store.ts b/src/store.ts", "--- a/src/store.ts", "+++ b/src/store.ts", "@@ -1,1 +1,2 @@", " ctx", "+new", ""].join("\n");
  const changed = buildChangeMap({ diff, candidates: [list, map] as UseCaseCandidate[] });
  assert.deepEqual(changed.files[0]!.seededBy, ["uc-list", "uc-map"], "in candidate order");
});

test("the changed code of a candidate lists each file once, direct before shared, code before styles, with the lines the change added", () => {
  const candidate = pageCandidate("/list", undefined, {
    seeds: [{ file: "src/list.scss", symbol: "*", addedLines: 1 }, { file: "src/list.ts", symbol: "render", addedLines: 4 }, { file: "src/list.ts", symbol: "paint", addedLines: 4 }],
    sharedSeeds: [{ file: "src/store.ts", symbol: "load", pages: 9, addedLines: 7 }, { file: "src/store.ts", symbol: "save", pages: 9, addedLines: 7 }, { file: "src/list.ts", symbol: "also", pages: 3 }],
  });

  assert.deepEqual(changedCodeOf(candidate), [
    { file: "src/list.ts", fileClass: "code", seeding: "direct", addedLines: 4 },
    { file: "src/store.ts", fileClass: "code", seeding: "shared", addedLines: 7, pages: 9 },
    { file: "src/list.scss", fileClass: "style", seeding: "direct", addedLines: 1 },
  ]);
});

test("a candidate with no seed has no changed code", () => {
  assert.deepEqual(changedCodeOf(pageCandidate("/empty")), []);
});

test("changed code is executable code of a declared language, never a style sheet, a template or a test file", () => {
  assert.equal(isChangedCode("src/store.ts"), true);
  assert.equal(isChangedCode("src/list.scss"), false);
  assert.equal(isChangedCode("src/list.html"), false);
  assert.equal(isChangedCode("src/store.spec.ts"), false);
});
