import { test } from "node:test";
import assert from "node:assert/strict";
/* expected values are fixed snapshots — do not rebase them to silence a failure */
import { classifyFailure } from "@kernel/failure-detail-class.ts";
import {
  bestRound,
  decideProgress,
  isLikelyRealBug,
  type RoundResult,
} from "@contexts/qa-run-orchestration/domain/helpers/progress-gate.ts";

test("classifyFailure", () => {
  const samples: Array<{ input: string; expected: string }> = [
    { input: "expect(locator).toHaveText(expected) failed\nExpected: 'Paid'\nReceived: 'Pending'", expected: "value-mismatch" },
    { input: "expect(locator).toBeVisible() failed\nExpected: visible\nReceived: <element(s) not found>", expected: "locator" },
    { input: "Timeout 30000ms exceeded while waiting for locator", expected: "locator" },
    { input: "getByRole('button', { name: 'Submit' }) resolved to 0 elements", expected: "locator" },
    { input: "some totally ambiguous free-text failure", expected: "other" },
    { input: "", expected: "other" },
  ];
  for (const s of samples) {
    assert.equal(classifyFailure(s.input), s.expected, `sample: ${JSON.stringify(s.input)}`);
  }
});

test("bestRound: fewest failures, ties prefer later", () => {
  const rounds = [{ failingCount: 3 }, { failingCount: 1 }, { failingCount: 1 }];
  assert.deepEqual(bestRound(rounds), { failingCount: 1 });
});

test("decideProgress: first retry (prev=null) always spends", () => {
  const cur: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0 };
  assert.deepEqual(decideProgress(null, cur), { spend: true, reason: "first retry — baseline established" });
});

test("decideProgress: regression (more failures) stops", () => {
  const prev: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0 };
  const cur: RoundResult = { failingNames: new Set(["a", "b"]), failingCount: 2, absentSelectors: new Set(), lever2Flips: 0 };
  assert.deepEqual(decideProgress(prev, cur), { spend: false, reason: "regression — failing count increased; keeping best round" });
});

test("decideProgress: signal A (fewer failures) spends", () => {
  const prev: RoundResult = { failingNames: new Set(["a", "b"]), failingCount: 2, absentSelectors: new Set(), lever2Flips: 0 };
  const cur: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0 };
  assert.deepEqual(decideProgress(prev, cur), { spend: true, reason: "progress (A): failing count 2 → 1" });
});

test("decideProgress: signal B (name set changed) spends", () => {
  const prev: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0 };
  const cur: RoundResult = { failingNames: new Set(["b"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0 };
  assert.deepEqual(decideProgress(prev, cur), { spend: true, reason: "progress (B): failing test set changed" });
});

test("decideProgress: signal B downgraded by reexplore thrash", () => {
  const prev: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0 };
  const cur: RoundResult = { failingNames: new Set(["b"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0, reexploreNavigations: 3 };
  assert.deepEqual(decideProgress(prev, cur), { spend: false, reason: "no progress — the failure set only reshuffled after 3 re-exploration call(s) on a grounded retry; stopping loop" });
});

test("decideProgress: signal C (lever2 flip) spends", () => {
  const prev: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(["role:name"]), lever2Flips: 0 };
  const cur: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 1 };
  assert.deepEqual(decideProgress(prev, cur), { spend: true, reason: "progress (C): 1 selector(s) flipped absent→present" });
});

test("decideProgress: fail-closed (no signal) stops", () => {
  const prev: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0 };
  const cur: RoundResult = { failingNames: new Set(["a"]), failingCount: 1, absentSelectors: new Set(), lever2Flips: 0 };
  assert.deepEqual(decideProgress(prev, cur), { spend: false, reason: "no progress — agent ignored ground truth; stopping loop" });
});

test("isLikelyRealBug: true case (unique + all value-mismatch)", () => {
  const details = ["expect(locator).toHaveText(expected) failed\nExpected: 'Paid'\nReceived: 'Pending'"];
  assert.equal(isLikelyRealBug(true, details), true);
});

test("isLikelyRealBug: false case (not unique)", () => {
  const details = ["expect(locator).toHaveText(expected) failed"];
  assert.equal(isLikelyRealBug(false, details), false);
});

test("isLikelyRealBug: false case (empty details)", () => {
  assert.equal(isLikelyRealBug(true, []), false);
});

test("isLikelyRealBug: false case (mixed classes)", () => {
  const details = ["expect(locator).toHaveText(expected) failed", "getByRole resolved to 0 elements"];
  assert.equal(isLikelyRealBug(true, details), false);
});
