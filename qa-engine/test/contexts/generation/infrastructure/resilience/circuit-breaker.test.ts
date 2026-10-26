/* qa-engine/test/contexts/generation/infrastructure/resilience/circuit-breaker.test.ts
   circuit breaker is SDK-free policy, so its tests do not depend on the SDK.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCircuit, recordCircuitFailure, recordCircuitSuccess, resetCircuit } from "@contexts/generation/infrastructure/resilience/circuit-breaker.ts";

test("circuit opens after the threshold of consecutive failures, and resetCircuit clears it", () => {
  resetCircuit();
  for (let i = 0; i < 5; i++) recordCircuitFailure("qa-author");
  assert.throws(() => checkCircuit("qa-author"), /circuit breaker is OPEN/);
  resetCircuit();
  assert.doesNotThrow(() => checkCircuit("qa-author")); /* the operator-recovery path is unblocked */
});

test("a success before the threshold resets the failure streak", () => {
  resetCircuit();
  recordCircuitFailure("qa-author");
  recordCircuitFailure("qa-author");
  recordCircuitSuccess("qa-author");
  recordCircuitFailure("qa-author");
  recordCircuitFailure("qa-author");
  assert.doesNotThrow(() => checkCircuit("qa-author")); /* only 2 consecutive since the success → still closed */
  resetCircuit();
});

/* Breaker state is keyed per role: a run-away qa-reviewer must not trip the breaker a healthy
   qa-author relies on, and a qa-reflector success must not reset a qa-author's
   genuinely-accumulating failure streak.
 */
test("tripping one role's circuit does not block a different role", () => {
  resetCircuit();
  for (let i = 0; i < 5; i++) recordCircuitFailure("qa-author");
  assert.throws(() => checkCircuit("qa-author"), /circuit breaker is OPEN/);
  assert.doesNotThrow(() => checkCircuit("qa-reviewer"), "an unrelated role's circuit must stay closed");
  resetCircuit();
});

test("a success on one role does not reset a different role's failure streak", () => {
  resetCircuit();
  recordCircuitFailure("qa-author");
  recordCircuitFailure("qa-author");
  recordCircuitFailure("qa-author");
  recordCircuitFailure("qa-author");
  recordCircuitSuccess("qa-reviewer"); /* an unrelated role's success */
  recordCircuitFailure("qa-author"); /* qa-author's 5th consecutive failure */
  assert.throws(
    () => checkCircuit("qa-author"),
    /circuit breaker is OPEN/,
    "qa-reviewer's success must not have reset qa-author's own failure streak",
  );
  resetCircuit();
});
