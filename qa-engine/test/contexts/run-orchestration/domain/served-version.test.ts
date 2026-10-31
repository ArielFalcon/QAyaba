import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { servedState, waitsForDeploy, needsHistory } from "@contexts/run-orchestration/domain/served-version.ts";

const HEAD = Sha.of("abc1234def5678");

test("a served commit equal to the run's sha is equal, whether either side is abbreviated or not", () => {
  assert.equal(servedState("abc1234def5678", HEAD, undefined), "equal");
  assert.equal(servedState("abc1234", HEAD, undefined), "equal");
  assert.equal(servedState("ABC1234DEF5678", HEAD, undefined), "equal");
});

test("a served commit that is another commit needs the mirror's history to be told apart", () => {
  assert.equal(needsHistory("abc1234def5678", HEAD), false);
  assert.equal(needsHistory("1111111", HEAD), true);
  /* below the 7-character floor a prefix is no match */
  assert.equal(needsHistory("abc1", HEAD), true);
});

test("a served commit that is an ancestor of the run's sha is behind: the deploy has not landed", () => {
  assert.equal(servedState("1111111", HEAD, "served-is-ancestor"), "behind");
});

test("a run's sha that is an ancestor of the served commit is ahead: a replay against a newer DEV", () => {
  assert.equal(servedState("1111111", HEAD, "head-is-ancestor"), "ahead");
});

test("neither an ancestor of the other is unrelated", () => {
  assert.equal(servedState("1111111", HEAD, "diverged"), "unrelated");
});

test("a served commit the mirror does not hold has no state: ancestry was not established, so the caller must not ask for one", () => {
  assert.throws(() => servedState("1111111", HEAD, "unknown-commit" as never), /relation/);
});

test("history that resolves the served commit to the run's own commit is equal", () => {
  assert.equal(servedState("1111111", HEAD, "same"), "equal");
});

test("a different commit with no history to compare is a defect of the caller, never a guessed state", () => {
  assert.throws(() => servedState("1111111", HEAD, undefined), /history/);
});

test("the gate waits only for a deploy-triggered run whose served version is behind", () => {
  assert.equal(waitsForDeploy("behind", "webhook"), true);
  for (const state of ["undeclared", "unreadable", "equal", "ahead", "unrelated"] as const) {
    assert.equal(waitsForDeploy(state, "webhook"), false, `${state} on a deploy-triggered run is recorded, not waited for`);
  }
  for (const state of ["undeclared", "unreadable", "equal", "behind", "ahead", "unrelated"] as const) {
    assert.equal(waitsForDeploy(state, "manual"), false, `${state} on a manual run is recorded, not waited for`);
  }
});
