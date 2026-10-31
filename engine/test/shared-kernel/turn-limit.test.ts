import { test } from "node:test";
import assert from "node:assert/strict";
import { ATTRIBUTES } from "@kernel/telemetry/attribute-registry.ts";
import { TURN_LIMITS, isBindingLimit } from "@kernel/turn-limit.ts";

test("the registry's description of qayaba.limit.fired names every value of the closed set a producer may emit", () => {
  const description = ATTRIBUTES["qayaba.limit.fired"].description;
  for (const limit of TURN_LIMITS) assert.ok(description.includes(limit), `${limit} is missing from the description of qayaba.limit.fired`);
});

test("a limit value the engine retired is in no part of the closed set", () => {
  assert.equal((TURN_LIMITS as readonly string[]).includes("wall-clock-budget"), false);
  assert.equal(ATTRIBUTES["qayaba.limit.fired"].description.includes("wall-clock-budget"), false);
  assert.equal(ATTRIBUTES["qayaba.limits"].description.includes("wall-clock"), false);
});

test("exactly the cancel, the fault and none are no binding limit", () => {
  assert.deepEqual(TURN_LIMITS.filter((limit) => !isBindingLimit(limit)), ["cancel", "fault", "none"]);
});
