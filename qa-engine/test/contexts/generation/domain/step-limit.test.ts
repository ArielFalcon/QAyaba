/* The milestone of a turn that writes tests: the step by which something should be written, as a fraction of the limit the runtime enforces, and the outcomes that meet it. Which turns write tests is decided here once. Asserted on numbers computed from the imported fraction and on the declared outcomes, never on wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RUN_MODES, type RunMode } from "@kernel/run-mode.ts";
import {
  STEP_LIMIT_MIDPOINT_FRACTION,
  isTestWritingTurn,
  stepMidpoint,
  stepMilestone,
} from "@contexts/generation/domain/step-limit.ts";

/* One signal of each kind that turns a first pass into a regeneration. */
const REGEN_SIGNALS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["failing cases", { fixCases: [{ name: "cart total" }] }],
  ["reviewer corrections", { reviewCorrections: ["scope the coupon button to the cart form"] }],
  ["a coverage gap", { coverageGap: "src/cart.ts: lines 10-14 were not executed" }],
  ["selector contradictions", { selectorContradictions: ["button:Apply is NOT in the captured tree"] }],
];

/* ── the midpoint ── */

test("the midpoint of a limit is that limit scaled by the named fraction, rounded down, and never before the first step", () => {
  for (const limit of [1, 2, 3, 25, 40, 41, 50, 99, 100]) {
    assert.equal(stepMidpoint(limit), Math.max(1, Math.floor(limit * STEP_LIMIT_MIDPOINT_FRACTION)), `limit ${limit}`);
  }
});

test("the midpoint is a whole step inside the turn: at least the first, and before the last of any limit with room for two", () => {
  assert.ok(STEP_LIMIT_MIDPOINT_FRACTION > 0 && STEP_LIMIT_MIDPOINT_FRACTION < 1, "a fraction of the turn, not the turn itself");
  assert.equal(stepMidpoint(1), 1, "a one-step turn has only its first step to ask for");
  for (let limit = 1; limit <= 200; limit++) {
    const midpoint = stepMidpoint(limit);
    assert.ok(Number.isInteger(midpoint) && midpoint >= 1, `limit ${limit}: a whole step from the first`);
    if (limit >= 2) assert.ok(midpoint < limit, `limit ${limit}: before the last step`);
  }
});

test("a larger limit never has an earlier midpoint", () => {
  let previous = 0;
  for (let limit = 1; limit <= 200; limit++) {
    const midpoint = stepMidpoint(limit);
    assert.ok(midpoint >= previous, `limit ${limit}`);
    previous = midpoint;
  }
});

/* ── which turns write tests ── */

test("a first pass writes tests in diff and manual mode, and in no other: complete, exhaustive and context first passes analyze", () => {
  const writes: Record<RunMode, boolean> = { diff: true, manual: true, complete: false, exhaustive: false, context: false };
  for (const mode of RUN_MODES) assert.equal(isTestWritingTurn({ mode }), writes[mode], mode);
});

test("a regeneration writes tests in every mode that writes any, whichever signal made it one, and a context run never does", () => {
  for (const mode of RUN_MODES) {
    for (const [label, signal] of REGEN_SIGNALS) {
      assert.equal(isTestWritingTurn({ mode, ...signal }), mode !== "context", `${mode} with ${label}`);
    }
  }
});

test("signals that are empty make no regeneration, so they make no test-writing turn where the first pass writes none", () => {
  const empty = { fixCases: [], reviewCorrections: [], coverageGap: "", selectorContradictions: [] };
  assert.equal(isTestWritingTurn({ mode: "complete", ...empty }), false);
  assert.equal(isTestWritingTurn({ mode: "exhaustive", ...empty }), false);
  assert.equal(isTestWritingTurn({ mode: "diff", ...empty }), true, "a diff first pass still writes");
});

/* ── the milestone ── */

test("a first pass that writes tests asks for the first spec or a reasoned no-op by the midpoint of its limit", () => {
  for (const mode of ["diff", "manual"] as const) {
    const milestone = stepMilestone({ mode }, 40);
    assert.equal(milestone?.midpoint, stepMidpoint(40), mode);
    assert.deepEqual(milestone?.outcomes, ["first-spec", "no-op"], mode);
  }
});

test("a regeneration asks for the first correction, or for the reason none applies, by the midpoint of its limit: it never offers the first pass's no-op", () => {
  for (const mode of RUN_MODES.filter((m) => m !== "context")) {
    for (const [label, signal] of REGEN_SIGNALS) {
      const milestone = stepMilestone({ mode, ...signal }, 40);
      assert.equal(milestone?.midpoint, stepMidpoint(40), `${mode} with ${label}`);
      assert.deepEqual(milestone?.outcomes, ["first-correction", "reason-none-applies"], `${mode} with ${label}`);
    }
  }
});

test("a turn that writes no tests has no milestone, whatever its limit", () => {
  for (const mode of ["complete", "exhaustive", "context"] as const) {
    assert.equal(stepMilestone({ mode }, 40), undefined, mode);
    assert.equal(stepMilestone({ mode }, 1), undefined, mode);
  }
  assert.equal(stepMilestone({ mode: "context", fixCases: [{ name: "cart total" }] }, 40), undefined, "a context run never regenerates");
});

test("the midpoint follows the limit it is asked for", () => {
  assert.equal(stepMilestone({ mode: "diff" }, 40)?.midpoint, stepMidpoint(40));
  assert.equal(stepMilestone({ mode: "diff" }, 25)?.midpoint, stepMidpoint(25));
  assert.equal(stepMilestone({ mode: "diff" }, 1)?.midpoint, 1);
  assert.notEqual(stepMidpoint(40), stepMidpoint(25), "setup: the two limits have different midpoints");
});
