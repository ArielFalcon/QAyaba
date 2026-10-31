import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BASE_BRANCH, DEFAULT_FIX_LOOP_MAX_RETRIES, DEFAULT_INTENT_LOCK, baseBranchOf, fixLoopMaxRetries, resolveDomPack, resolveIntentLock } from "@contexts/run-orchestration/domain/run-policy.ts";

test("the fix loop retries twice where the app declares nothing, and the app's count where it declares one (0 included)", () => {
  assert.equal(DEFAULT_FIX_LOOP_MAX_RETRIES, 2);
  assert.equal(fixLoopMaxRetries(undefined), 2);
  assert.equal(fixLoopMaxRetries({}), 2);
  assert.equal(fixLoopMaxRetries({ maxRetries: 0 }), 0);
  assert.equal(fixLoopMaxRetries({ maxRetries: 5 }), 5);
});

test("the test-intent lock signals at an opacity ratio of 0.5 where the app declares nothing, and each key it declares is the lock's", () => {
  assert.deepEqual(DEFAULT_INTENT_LOCK, { mode: "signal", opacityFlagRatio: 0.5 });
  assert.deepEqual(resolveIntentLock(undefined), { mode: "signal", opacityFlagRatio: 0.5 });
  assert.deepEqual(resolveIntentLock({}), { mode: "signal", opacityFlagRatio: 0.5 });
  assert.deepEqual(resolveIntentLock({ mode: "off" }), { mode: "off", opacityFlagRatio: 0.5 });
  assert.deepEqual(resolveIntentLock({ opacityFlagRatio: 0 }), { mode: "signal", opacityFlagRatio: 0 });
  assert.deepEqual(Object.keys(resolveIntentLock({ opacityFlagRatio: 0.2, mode: "off" })), ["mode", "opacityFlagRatio"]);
});

test("the live DOM is in the context pack unless the run or the app turns it off, and the run's choice wins", () => {
  assert.equal(resolveDomPack(undefined, undefined), true);
  assert.equal(resolveDomPack(undefined, false), false);
  assert.equal(resolveDomPack(null, false), false, "a null request asks for nothing");
  assert.equal(resolveDomPack(false, true), false);
  assert.equal(resolveDomPack(true, false), true);
});

test("a run is based on main unless the app names a branch", () => {
  assert.equal(DEFAULT_BASE_BRANCH, "main");
  assert.equal(baseBranchOf({}), "main");
  assert.equal(baseBranchOf({ baseBranch: "develop" }), "develop");
});
