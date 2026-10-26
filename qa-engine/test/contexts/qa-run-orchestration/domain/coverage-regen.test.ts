/* Whether a blocking measurement earns the one coverage regeneration. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { coverageRegenAction, MAX_COVERAGE_REGENERATIONS } from "@contexts/qa-run-orchestration/domain/coverage-regen.ts";

const blocked = { measured: true, blocks: true, perCommit: true, regenerated: 0 };

test("a blocking measurement of a per-commit diff run earns a regeneration", () => {
  assert.equal(coverageRegenAction(blocked), "regenerate");
});
test("a measurement that does not block keeps the first measurement", () => {
  assert.equal(coverageRegenAction({ ...blocked, blocks: false }), "keep");
});
test("a run with no measurement keeps it", () => {
  assert.equal(coverageRegenAction({ ...blocked, measured: false }), "keep");
});
test("a run without a per-commit signal does not regenerate", () => {
  assert.equal(coverageRegenAction({ ...blocked, perCommit: false }), "keep");
});
test("exactly one regeneration is spent", () => {
  assert.equal(MAX_COVERAGE_REGENERATIONS, 1);
  assert.equal(coverageRegenAction({ ...blocked, regenerated: 1 }), "keep");
});
