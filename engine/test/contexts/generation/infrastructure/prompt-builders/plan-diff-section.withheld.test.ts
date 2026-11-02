/* The planning diff's section says what it held back: a whitespace-only piece never reaches the fence, and one line after it states how many pieces and bytes were withheld, with the counts per reason. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pieceLocation, planDiff } from "@contexts/generation/domain/plan-diff.ts";
import { PlanDiffSection } from "@contexts/generation/infrastructure/prompt-builders/plan-diff-section.ts";
import type { UseCaseCandidate } from "@kernel/use-case-candidate.ts";
import type { ChangedSymbol } from "@kernel/change-reach.ts";
import { pageCandidate } from "../../../../support/use-case-candidate.ts";

const HEADERS = (path: string): string[] => [`diff --git a/${path} b/${path}`, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`];

function hunk(start: number, change: { added?: string[]; removed?: string[] } = {}): string[] {
  const removed = change.removed ?? [];
  const added = change.added ?? [];
  return [`@@ -${start},${removed.length} +${start},${added.length} @@`, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`), ""];
}

const fileWithHunk = (path: string, start: number, change: { added?: string[]; removed?: string[] } = {}): string => [...HEADERS(path), ...hunk(start, change)].join("\n");

const seed = (file: string, start: number, end: number): ChangedSymbol => ({ file, symbol: "total", range: { start, end } });

const candidate = (seeds: ChangedSymbol[]): UseCaseCandidate => pageCandidate("/cart", undefined, { seeds });

/* The fenced diff of the section: what the judges read back. */
const fenced = (section: string): string => /```diff\n([\s\S]*?)\n```/.exec(section)?.[1] ?? "";

const CART = "src/cart/cart.service.ts";
const TOTALS = "src/cart/totals.ts";
const SHOP = "src/shop/shop.service.ts";
const CART_SPEC = "src/cart/cart.service.spec.ts";
const ORDER_SPEC = "src/order/order.service.spec.ts";

test("a piece whose only change is reindentation is named as formatting only and never reaches the fence", () => {
  const diff =
    fileWithHunk(TOTALS, 40, { removed: ["if (items.length > 0) {", "  show(items);", "}"], added: ["    if (items.length > 0) {", "        show(items);", "    }"] }) +
    fileWithHunk(CART, 10, { added: ["export const total = 3;"] }) +
    fileWithHunk(SHOP, 20, { added: ["export const shop = 1;"] });
  const plan = planDiff(diff, [candidate([seed(TOTALS, 40, 42), seed(CART, 10, 10)])]);
  const section = new PlanDiffSection(plan);

  assert.deepEqual(
    { fenced: fenced(section.render(section.pieces)).includes("show(items);"), why: plan.referenceOnly.find((piece) => pieceLocation(piece) === `${TOTALS}:40-42`)?.why },
    { fenced: false, why: "formatting-only" },
  );
});

test("the line after the fence states the pieces and the bytes held back, counted per reason", () => {
  const diff =
    fileWithHunk(CART, 10, { added: ["export const total = 3;"] }) +
    fileWithHunk(SHOP, 20, { added: ["export const shop = 1;"] }) +
    fileWithHunk(CART_SPEC, 5, { added: ["it('totals the cart', () => {});"] }) +
    fileWithHunk(ORDER_SPEC, 7, { added: ["it('lists the orders', () => {});"] });
  const section = new PlanDiffSection(planDiff(diff, [candidate([seed(CART, 10, 10)])]));

  assert.match(section.render(section.pieces), /^3 of 4 pieces, \d+ bytes, held back by the selection: 1 no-use-case candidate, 2 app test file$/m);
});
