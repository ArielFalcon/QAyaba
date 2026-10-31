import { test } from "node:test";
import assert from "node:assert/strict";
import { closedLoopLimitsOf } from "@contexts/agent-tools/domain/closed-loop-limits.ts";
import { DEFAULT_CLOSED_LOOP_LIMITS } from "@kernel/closed-loop.ts";

test("an app that declares no closed-loop limits gets the kernel's, with no ceiling on its flows' calls", () => {
  assert.deepEqual(closedLoopLimitsOf(undefined), DEFAULT_CLOSED_LOOP_LIMITS);
  assert.deepEqual(closedLoopLimitsOf({}), DEFAULT_CLOSED_LOOP_LIMITS);
  assert.equal("callsCeiling" in closedLoopLimitsOf({ perCallMs: 60_000 }), false);
});

test("each limit the app declares is the run's, and the ones it leaves out keep the kernel's", () => {
  assert.deepEqual(closedLoopLimitsOf({ perCallMs: 60_000 }), { ...DEFAULT_CLOSED_LOOP_LIMITS, perCallMs: 60_000 });
  assert.equal(closedLoopLimitsOf({ maxDevWrites: 0 }).maxDevWrites, 0, "a declared 0 is the app's, not a missing value");
});

test("the app's maxCalls is also the ceiling on its flows' calls together", () => {
  assert.deepEqual(closedLoopLimitsOf({ maxCalls: 3 }), { maxCalls: 3, perCallMs: DEFAULT_CLOSED_LOOP_LIMITS.perCallMs, maxDevWrites: DEFAULT_CLOSED_LOOP_LIMITS.maxDevWrites, callsCeiling: 3 });
});
