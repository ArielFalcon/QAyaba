/* The hunks of a diff that overlap the lines of the symbols a change touched, bounded for a brief. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hunksFor, MAX_HUNKS, MAX_HUNK_LINES } from "@kernel/diff-parser/hunks-for.ts";

const body = (from: number, count: number, mark = "+"): string => Array.from({ length: count }, (_, i) => `${mark}line ${from + i}`).join("\n");
const diff = [
  "diff --git a/src/cart.ts b/src/cart.ts",
  "--- a/src/cart.ts",
  "+++ b/src/cart.ts",
  "@@ -3,2 +3,3 @@ export function total()",
  " keep 3",
  "+added 4",
  " keep 5",
  "@@ -40,1 +41,2 @@ export function tax()",
  " keep 41",
  "+added 42",
  "diff --git a/src/other.ts b/src/other.ts",
  "--- a/src/other.ts",
  "+++ b/src/other.ts",
  "@@ -1,1 +1,2 @@",
  " keep 1",
  "+added 2",
].join("\n");

test("a seed gets the hunks of its file that overlap its range, and no other hunk", () => {
  const hunks = hunksFor(diff, [{ file: "src/cart.ts", symbol: "total", range: { start: 1, end: 10 } }]);
  assert.equal(hunks.length, 1);
  assert.ok(hunks[0]!.startsWith("src/cart.ts\n@@ -3,2 +3,3 @@"));
  assert.ok(hunks[0]!.includes("+added 4") && !hunks[0]!.includes("added 42"));
});

test("a seed with no range takes every hunk of its file, and a seed in a file the diff does not touch takes none", () => {
  assert.equal(hunksFor(diff, [{ file: "src/cart.ts", symbol: "cart" }]).length, 2);
  assert.deepEqual(hunksFor(diff, [{ file: "src/untouched.ts", symbol: "x", range: { start: 1, end: 5 } }]), []);
});

test("a hunk shared by two seeds is returned once, in diff order", () => {
  const hunks = hunksFor(diff, [{ file: "src/cart.ts", symbol: "tax", range: { start: 41, end: 44 } }, { file: "src/cart.ts", symbol: "total", range: { start: 4, end: 4 } }, { file: "src/cart.ts", symbol: "total2", range: { start: 3, end: 5 } }]);
  assert.equal(hunks.length, 2);
  assert.ok(hunks[0]!.includes("@@ -3,2") && hunks[1]!.includes("@@ -40,1"));
});

test("a hunk is cut at its line bound and says how many lines it left out", () => {
  const long = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", `@@ -1,0 +1,${MAX_HUNK_LINES + 10} @@`, body(1, MAX_HUNK_LINES + 10)].join("\n");
  const [hunk] = hunksFor(long, [{ file: "a.ts", symbol: "f", range: { start: 1, end: 100 } }]);
  assert.ok(hunk!.includes(`line ${MAX_HUNK_LINES}`) && !hunk!.includes(`line ${MAX_HUNK_LINES + 1}\n`));
  assert.match(hunk!, /10 more line\(s\)/);
});

test("no more hunks than the bound are returned", () => {
  const many = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", ...Array.from({ length: MAX_HUNKS + 2 }, (_, i) => `@@ -${i * 10 + 1},1 +${i * 10 + 1},2 @@\n keep\n+added ${i}`)].join("\n");
  assert.equal(hunksFor(many, [{ file: "a.ts", symbol: "f" }]).length, MAX_HUNKS);
});

test("an empty diff or no seeds give no hunks", () => {
  assert.deepEqual(hunksFor("", [{ file: "a.ts", symbol: "f" }]), []);
  assert.deepEqual(hunksFor(diff, []), []);
});
