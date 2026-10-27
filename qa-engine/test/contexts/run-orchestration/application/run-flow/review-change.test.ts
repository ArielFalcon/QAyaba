/* What the reviewer of a planned run is given instead of the whole diff: the slices of the flows under review, every changed file, and everything no flow under review holds, so it never sees less than the change. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewChangeViewOf } from "@contexts/run-orchestration/application/run-flow/review-change.ts";
import { pageCandidate } from "../../../../support/use-case-candidate.ts";

function fileDiff(path: string, hunks: ReadonlyArray<{ start: number; added: number }>): string {
  const body = hunks.map((h) => [`@@ -${h.start},1 +${h.start},${h.added + 1} @@`, " ctx", ...Array.from({ length: h.added }, (_, i) => `+new ${path} ${h.start + i}`)].join("\n"));
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...body, ""].join("\n");
}

const deleted = ["diff --git a/src/coupon.ts b/src/coupon.ts", "deleted file mode 100644", "--- a/src/coupon.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-export const coupon = 1;", "-export const rate = 2;", ""].join("\n");
const DIFF = fileDiff("src/cart.ts", [{ start: 3, added: 2 }, { start: 40, added: 1 }]) + fileDiff("src/shop.ts", [{ start: 10, added: 2 }]) + fileDiff("src/cart.test.ts", [{ start: 1, added: 3 }]) + deleted;

const cart = pageCandidate("/cart", undefined, { id: "uc-cart", seeds: [{ file: "src/cart.ts", symbol: "total", range: { start: 1, end: 6 } }] });
const shop = pageCandidate("/shop", undefined, { id: "uc-shop", seeds: [{ file: "src/shop.ts", symbol: "list", range: { start: 10, end: 12 } }] });
const FLOWS = [
  { specFile: "flows/cart.spec.ts", candidates: ["uc-cart"] },
  { specFile: "flows/shop.spec.ts", candidates: ["uc-shop"] },
];

test("a planned review gets the slice of each flow under review, every changed file, the hunks no flow under review holds in full and the referenced-only hunks", () => {
  const view = reviewChangeViewOf({ diff: DIFF, candidates: [cart, shop], flows: FLOWS, specsUnderReview: ["flows/cart.spec.ts"], specRelDir: "e2e" });
  assert.ok(view, "the flow under review owns part of the change");
  assert.deepEqual(view.files.map((f) => f.path), ["src/cart.ts", "src/shop.ts", "src/cart.test.ts", "src/coupon.ts"]);
  assert.deepEqual(view.flows.map((f) => ({ specFile: f.specFile, candidateIds: f.candidateIds, owned: f.owned.map((o) => `${o.hunk.file}:${o.hunk.newStart}`) })), [
    { specFile: "flows/cart.spec.ts", candidateIds: ["uc-cart"], owned: ["src/cart.ts:3"] },
  ]);
  /* The shop flow is not under review, so the hunk its slice would own is shown in full with the rest no flow under review holds. */
  assert.deepEqual(view.unassigned.map((u) => `${u.hunk.file}:${u.hunk.newStart}`), ["src/cart.ts:40", "src/shop.ts:10"]);
  assert.deepEqual(view.hunkless.map((h) => h.path), ["src/coupon.ts"]);
  assert.ok(view.hunkless[0]!.section.includes("-export const coupon = 1;"), "the deletion is given whole");
  assert.deepEqual(view.referenced.map((r) => `${r.path}:${r.start}-${r.end} ${r.why}`), ["src/cart.test.ts:1-4 test-file"]);
});

test("a flow's spec is matched whether or not it is spelled with the spec directory", () => {
  const view = reviewChangeViewOf({ diff: DIFF, candidates: [cart], flows: [{ specFile: "e2e/flows/cart.spec.ts", candidates: ["uc-cart"] }], specsUnderReview: ["flows/cart.spec.ts"], specRelDir: "e2e" });
  assert.deepEqual(view?.flows.map((f) => f.specFile), ["e2e/flows/cart.spec.ts"]);
});

test("with no plan, no flow under review, or nothing a flow under review owns, the reviewer keeps the whole diff", () => {
  assert.equal(reviewChangeViewOf({ diff: DIFF, candidates: [cart, shop], flows: [], specsUnderReview: ["flows/cart.spec.ts"], specRelDir: "e2e" }), undefined);
  assert.equal(reviewChangeViewOf({ diff: DIFF, candidates: [cart, shop], flows: FLOWS, specsUnderReview: ["flows/other.spec.ts"], specRelDir: "e2e" }), undefined);
  assert.equal(reviewChangeViewOf({ diff: DIFF, candidates: [], flows: FLOWS, specsUnderReview: ["flows/cart.spec.ts"], specRelDir: "e2e" }), undefined);
  assert.equal(reviewChangeViewOf({ diff: "", candidates: [cart], flows: FLOWS, specsUnderReview: ["flows/cart.spec.ts"], specRelDir: "e2e" }), undefined);
});
