import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { enforcedStepLimit } from "./step-limit";

test("a safe positive integer is the limit", () => {
  for (const limit of [1, 2, 25, 50, Number.MAX_SAFE_INTEGER]) {
    assert.equal(enforcedStepLimit(limit), limit);
  }
});

test("a value that cannot be a limit is none: no number is made up for it", () => {
  const notALimit: unknown[] = [
    0, -0, -1, -50, 2.5, 0.5, 40.000001,
    Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
    "40", "", "many",
    null, undefined, true, false, [40], { steps: 40 }, 40n,
  ];
  for (const value of notALimit) {
    assert.equal(enforcedStepLimit(value), undefined, `${inspect(value)} is not a limit`);
  }
});
