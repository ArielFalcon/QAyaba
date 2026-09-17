import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCycleBackstop } from "@contexts/qa-run-orchestration/domain/helpers/derive-cycle-backstop.ts";

/* CYCLES_PER_GENERATE=2, MAX_STATIC_FIX_ROUNDS=2, REPAIR_HEADROOM_PER_GENERATE=2.
 */

test("deriveCycleBackstop: maxRetries=0 — single-agent, no retries budgeted", () => {
  assert.equal(deriveCycleBackstop(0), 16);
});

test("deriveCycleBackstop: maxRetries=2 — the common default", () => {
  assert.equal(deriveCycleBackstop(2), 24);
});

test("deriveCycleBackstop: maxRetries=5 — a high-retry config", () => {
  assert.equal(deriveCycleBackstop(5), 36);
});

test("deriveCycleBackstop: numObjectives=1 (default) reduces to the single-objective derivation", () => {
  assert.equal(deriveCycleBackstop(2, 1), deriveCycleBackstop(2));
});

test("deriveCycleBackstop: numObjectives>1 adds one session's worth of budget per extra objective", () => {
  /* extraObjectives = 3 - 1 = 2; +2 * (2 + 2) = +8 over the single-objective base (24) */
  assert.equal(deriveCycleBackstop(2, 3), deriveCycleBackstop(2) + 8);
});

test("deriveCycleBackstop: numObjectives=0 never lowers the base (Math.max(0, ...) floor)", () => {
  assert.equal(deriveCycleBackstop(2, 0), deriveCycleBackstop(2));
});
