import { test } from "node:test";
import assert from "node:assert/strict";
import { heldTo } from "@kernel/allotment-cap.ts";

test("a cap below the deadline's allowance is the time a purpose gets, typed as the cap", () => {
  assert.deepEqual(heldTo({ ms: 480_000, limit: "flow-budget" }, 900_000), { ms: 480_000, limit: "flow-budget" });
});

test("an allowance below the cap is the time a purpose gets, typed as the purpose's allotment", () => {
  assert.deepEqual(heldTo({ ms: 480_000, limit: "flow-budget" }, 200_000), { ms: 200_000, limit: "allotment" });
});

test("a cap equal to the allowance ends on the deadline, which is the allotment's (the stronger fact)", () => {
  assert.deepEqual(heldTo({ ms: 180_000, limit: "plan-budget" }, 180_000), { ms: 180_000, limit: "allotment" });
});

test("with no deadline armed the cap stands alone", () => {
  assert.deepEqual(heldTo({ ms: 120_000, limit: "tool-call" }, null), { ms: 120_000, limit: "tool-call" });
  assert.deepEqual(heldTo({ ms: 120_000, limit: "tool-call" }, undefined), { ms: 120_000, limit: "tool-call" });
});

test("an allowance already spent leaves nothing, never a negative time", () => {
  assert.deepEqual(heldTo({ ms: 120_000, limit: "tier-budget" }, -5), { ms: 0, limit: "allotment" });
});
