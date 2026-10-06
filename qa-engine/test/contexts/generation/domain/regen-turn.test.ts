import { test } from "node:test";
import assert from "node:assert/strict";
import { isReGenTurn } from "@contexts/generation/domain/regen-turn.ts";

test("a turn with none of the correction signals is a first pass", () => {
  assert.equal(isReGenTurn({}), false);
});

test("a turn that carries any one correction signal is a regeneration", () => {
  assert.equal(isReGenTurn({ fixCases: [{ name: "t" }] }), true);
  assert.equal(isReGenTurn({ reviewCorrections: ["fix the selector"] }), true);
  assert.equal(isReGenTurn({ coverageGap: "lines 10-14 were not executed" }), true);
  assert.equal(isReGenTurn({ selectorContradictions: ["button:x is not in the tree"] }), true);
});

test("empty signals do not make a regeneration", () => {
  assert.equal(isReGenTurn({ fixCases: [], reviewCorrections: [], coverageGap: "", selectorContradictions: [] }), false);
});

test("a regeneration stays a regeneration when several signals arrive together", () => {
  assert.equal(
    isReGenTurn({ fixCases: [{ name: "t" }], reviewCorrections: ["x"], coverageGap: "gap", selectorContradictions: ["c"] }),
    true,
  );
});
