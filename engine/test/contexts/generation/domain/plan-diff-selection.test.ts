/* The lead's planning diff shows a piece only when a use-case candidate stands on it, holds a whitespace-only change back and names every other piece once with why; a diff no candidate backs keeps the earlier treatment, so no plan turn is left without a diff. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pieceLocation, planDiff, type PlanDiff } from "@contexts/generation/domain/plan-diff.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { ChangedSymbol } from "@kernel/change-reach.ts";
import { pageCandidate } from "../../../support/use-case-candidate.ts";

const HEADERS = (path: string): string[] => [`diff --git a/${path} b/${path}`, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`];

/* One hunk of a file, the removed lines before the added ones. */
function hunk(start: number, change: { added?: string[]; removed?: string[] } = {}): string[] {
  const removed = change.removed ?? [];
  const added = change.added ?? [];
  return [`@@ -${start},${removed.length} +${start},${added.length} @@`, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`), ""];
}

const fileWithHunk = (path: string, start: number, change: { added?: string[]; removed?: string[] } = {}): string => [...HEADERS(path), ...hunk(start, change)].join("\n");

const seed = (file: string, start: number, end: number): ChangedSymbol => ({ file, symbol: "total", range: { start, end } });

const candidate = (seeds: ChangedSymbol[]): UseCaseCandidate => pageCandidate("/cart", undefined, { seeds });

/* Every piece of the plan once: the ones a prompt may show and the ones it only names. */
const everyPiece = (plan: PlanDiff): string[] => [...plan.ranked.map(pieceLocation), ...plan.referenceOnly.map(pieceLocation)].sort();

/* The diff's pieces as the earlier treatment lists them: no candidate backs anything, so every piece is ranked or named by kind alone. */
const allPieces = (diff: string): string[] => everyPiece(planDiff(diff, []));

const named = (plan: PlanDiff): Array<[string, string]> => plan.referenceOnly.map((piece) => [pieceLocation(piece), piece.why] as [string, string]).sort();

const CART = "src/cart/cart.service.ts";
const TOTALS = "src/cart/totals.ts";
const SHOP = "src/shop/shop.service.ts";
const CART_SPEC = "src/cart/cart.service.spec.ts";

/* A change of three files: the cart service a candidate stands on, the shop service no candidate reaches, and the app's own test file. */
const mixedDiff = (): string =>
  fileWithHunk(CART, 10, { added: ["export const total = 3;"] }) +
  fileWithHunk(SHOP, 20, { added: ["export const shop = 1;"] }) +
  fileWithHunk(CART_SPEC, 5, { added: ["it('totals the cart', () => {});"] });

test("a diff whose pieces a candidate backs shows those pieces and names the others with no candidate", () => {
  const plan = planDiff(mixedDiff(), [candidate([seed(CART, 10, 10)])]);

  assert.deepEqual({ shown: plan.ranked.map(pieceLocation), named: named(plan) }, { shown: [`${CART}:10-10`], named: [[`${CART_SPEC}:5-5`, "test-file"], [`${SHOP}:20-20`, "no-candidate"]] });
});

test("a diff of a run with no candidates keeps the earlier treatment: every piece a prompt may show is ranked", () => {
  const plan = planDiff(mixedDiff(), []);

  assert.deepEqual({ shown: plan.ranked.map(pieceLocation).sort(), named: named(plan) }, { shown: [`${CART}:10-10`, `${SHOP}:20-20`], named: [[`${CART_SPEC}:5-5`, "test-file"]] });
});

test("a diff no candidate's seeds are in falls back to the earlier treatment rather than reaching the plan empty", () => {
  const plan = planDiff(mixedDiff(), [candidate([seed("src/cart/cart.other.ts", 1, 2)])]);

  assert.deepEqual(plan.ranked.map(pieceLocation).sort(), [`${CART}:10-10`, `${SHOP}:20-20`]);
});

test("every piece of a diff is shown once or named once, whatever the selection holds back", () => {
  const diff = mixedDiff() + fileWithHunk(TOTALS, 40, { removed: ["show(items);"], added: ["    show(items);"] });

  const plan = planDiff(diff, [candidate([seed(CART, 10, 10)])]);

  assert.deepEqual(everyPiece(plan), allPieces(diff));
});
