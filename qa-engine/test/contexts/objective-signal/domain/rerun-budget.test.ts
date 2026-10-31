/* A re-run of the mutation pass is estimated from the run's own final execution: the measured time of the cases it would execute, and it starts only when the coverage purpose's allowance holds that. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rerunEstimateMs, rerunFits } from "@contexts/objective-signal/domain/rerun-budget.ts";
import type { QaCase } from "@kernel/qa-case.ts";

const cases: QaCase[] = [
  { name: "flows/cart.spec.ts › adds an item", status: "pass", file: "flows/cart.spec.ts", durationMs: 40_000 },
  { name: "flows/cart.spec.ts › empties the cart", status: "fail", file: "flows/cart.spec.ts", durationMs: 25_000 },
  { name: "flows/search.spec.ts › finds a shop", status: "pass", file: "flows/search.spec.ts", durationMs: 90_000 },
];

test("a re-run is estimated at the measured time of every case of its spec files, whatever each case ended in", () => {
  assert.equal(rerunEstimateMs(cases, ["flows/cart.spec.ts"]), 40_000 + 25_000);
  assert.equal(rerunEstimateMs(cases, ["flows/cart.spec.ts", "flows/search.spec.ts"]), 40_000 + 25_000 + 90_000);
});

test("a re-run that names its tests is estimated at those tests alone, named as the coverage fixture names their dumps", () => {
  assert.equal(rerunEstimateMs(cases, ["flows/cart.spec.ts"], ["flows-cart-spec-ts-adds-an-item"]), 40_000);
});

test("a re-run with no known case, or a case with no measured time, has no estimate", () => {
  assert.equal(rerunEstimateMs(cases, ["flows/other.spec.ts"]), undefined);
  assert.equal(rerunEstimateMs([{ name: "flows/cart.spec.ts › adds an item", status: "pass", file: "flows/cart.spec.ts" }], ["flows/cart.spec.ts"]), undefined);
});

test("a re-run starts when nothing bounds the run or the allowance holds its estimate, and never once the allowance is spent", () => {
  assert.equal(rerunFits(null, 90_000), true);
  assert.equal(rerunFits(90_000, 90_000), true);
  assert.equal(rerunFits(89_999, 90_000), false);
  assert.equal(rerunFits(0, undefined), false);
  assert.equal(rerunFits(1, undefined), true);
});
