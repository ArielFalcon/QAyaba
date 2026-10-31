import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_COVERAGE_BRANCH_CASES, DEFAULT_COVERAGE_MIN_RATIO, DEFAULT_COVERAGE_MODE, bundleMutationEnabled, resolveCoveragePolicy } from "@contexts/objective-signal/domain/coverage-policy.ts";

test("an app that declares no change-coverage block records the measurement, blocks nothing and regenerates from untaken arms", () => {
  const expected = { mode: "signal", minRatio: 0.7, branchCases: "regenerate" };
  assert.deepEqual(resolveCoveragePolicy(undefined), expected);
  assert.deepEqual(resolveCoveragePolicy({}), expected);
  assert.deepEqual([DEFAULT_COVERAGE_MODE, DEFAULT_COVERAGE_MIN_RATIO, DEFAULT_COVERAGE_BRANCH_CASES], ["signal", 0.7, "regenerate"]);
});

test("each key the app declares is the policy's, and the keys it leaves out keep their defaults", () => {
  assert.deepEqual(resolveCoveragePolicy({ mode: "enforce" }), { mode: "enforce", minRatio: 0.7, branchCases: "regenerate" });
  assert.deepEqual(resolveCoveragePolicy({ mode: "off", minRatio: 0.85, branchCases: "off" }), { mode: "off", minRatio: 0.85, branchCases: "off" });
  assert.equal(resolveCoveragePolicy({ minRatio: 0 }).minRatio, 0, "a declared 0 is the app's, not a missing value");
});

test("the policy lists mode, minRatio and branchCases in that order", () => {
  assert.deepEqual(Object.keys(resolveCoveragePolicy({ branchCases: "off", minRatio: 0.5, mode: "enforce" })), ["mode", "minRatio", "branchCases"]);
});

test("the mutation pass runs unless the app's change-coverage block turns it off", () => {
  assert.equal(bundleMutationEnabled(undefined), true);
  assert.equal(bundleMutationEnabled({}), true);
  assert.equal(bundleMutationEnabled({ bundleMutation: "signal" }), true);
  assert.equal(bundleMutationEnabled({ bundleMutation: "off" }), false);
  assert.equal(bundleMutationEnabled({ mode: "enforce", minRatio: 0.9 }), true, "no other key switches it");
});
